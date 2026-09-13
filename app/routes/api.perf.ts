import type { Route } from "./+types/api.perf";
import {
  clearPerfSamples,
  perfHistory,
  recordPerfSamples,
} from "../lib/db.server";
import {
  PERF_DIMENSIONS,
  PERF_MAX_BATCH,
  type PerfDimension,
  type PerfSampleRow,
} from "../lib/schema";
import {
  apiError,
  apiJson,
  requireMethod,
  type PerfHistoryResponse,
  type PerfIngestResponse,
} from "../lib/api-types";

/** 一度に返すビルドの数の上限（D1 のバインドは1文100個まで）。 */
const MAX_BUILDS = 40;
/** 文字列の列に入れてよい長さ。長い名乗りをそのまま貯め込まないため。 */
const MAX_TEXT = 64;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value !== ""
    ? value.slice(0, MAX_TEXT)
    : fallback;
}

/**
 * 受け取った標本を1件ずつ検分する。
 *
 * 形の違うものは**捨てる**（400 にしない）。送るのはブラウザに溜まった
 * 控えで、一部が壊れていたときに全体を断ると、その端末は以後ずっと
 * 何も送れなくなる——控えは成功するまで消えないので、壊れた1件が
 * 残りの記録を道連れにし続ける。
 */
function toRow(value: unknown): PerfSampleRow | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Record<string, unknown>;
  const at = Number(s.t);
  const ms = Number(s.ms);
  if (typeof s.id !== "string" || s.id === "") return null;
  if (!Number.isFinite(at) || at <= 0) return null;
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (typeof s.path !== "string" || s.path === "") return null;
  if (typeof s.build !== "string" || s.build === "") return null;
  return {
    id: s.id.slice(0, MAX_TEXT),
    at: Math.round(at),
    build: text(s.build),
    path: text(s.path),
    ms: Math.round(ms),
    deviceId: text(s.deviceId, "unknown"),
    device: text(s.device, "不明"),
    browser: text(s.browser, "不明"),
    mode: text(s.mode, "browser"),
  };
}

/** 履歴。切り口（ページ・端末・ブラウザ・表示形態）は問い合わせで選ぶ。 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const asked = url.searchParams.get("dimension");
  // 画面から来た文字列をそのまま SQL へ渡さない。表に無い名前は既定へ落とす
  const dimension: PerfDimension = PERF_DIMENSIONS.includes(
    asked as PerfDimension,
  )
    ? (asked as PerfDimension)
    : "path";
  const askedBuilds = Number(url.searchParams.get("builds"));
  const builds = Number.isFinite(askedBuilds)
    ? Math.min(MAX_BUILDS, Math.max(1, Math.trunc(askedBuilds)))
    : 10;
  // ページの絞り込みは束縛で渡すので、長さだけ見て素通しでよい
  const path = url.searchParams.get("path")?.slice(0, MAX_TEXT) || undefined;
  const history = await perfHistory({ dimension, builds, path });
  return apiJson<PerfHistoryResponse>(
    { dimension, path: path ?? null, ...history },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** 標本の受け取り（POST）と、記録の全消し（DELETE）。 */
export async function action({ request }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST", "DELETE"]);
  if (bad) return bad;

  if (request.method === "DELETE") {
    await clearPerfSamples();
    return apiJson<PerfIngestResponse>({ accepted: 0 });
  }

  let body: { samples?: unknown };
  try {
    body = (await request.json()) as { samples?: unknown };
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (!Array.isArray(body.samples)) {
    return apiError("不正なリクエストです", 400);
  }
  const rows = body.samples
    .slice(0, PERF_MAX_BATCH)
    .map(toRow)
    .filter((r): r is PerfSampleRow => r !== null);
  const accepted = await recordPerfSamples(rows);
  return apiJson<PerfIngestResponse>({ accepted });
}
