import type { Route } from "./+types/api.page";
import { apiError, apiJson, requireMethod, type PageResponse } from "../lib/api-types";
import { getAppSettings } from "../lib/db.server";
import { fetchPage, pageLimitsOf } from "../lib/page-fetch.server";

/**
 * 入力欄に貼られたリンクの取り込み。
 *
 * 本文の取り出し（HTML → 読める文章）はブラウザ側でやるので、ここは
 * 取ってきたものをそのまま返す。取りに行ってよい宛先かの判定は
 * `page-fetch.server.ts`（転送の途中も1段ずつ見る）。
 *
 * 鍵は要らない。D1 は上限の設定を引くためだけに読む。
 */
export async function action({ request }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;

  const body = (await request.json().catch(() => null)) as {
    url?: unknown;
  } | null;
  if (typeof body?.url !== "string" || body.url === "") {
    return apiError("url は必須です", 400);
  }

  // 上限は設定から引く（`pageMaxMb` / `pageTimeoutSec`）。値を書き写すと、
  // 設定を変えても効かないという、画面に何も出ない壊れ方をする
  const limits = pageLimitsOf(await getAppSettings());
  const result = await fetchPage(body.url, new URL(request.url).host, limits);
  if (!result.ok) return apiError(result.error, result.status);
  return apiJson<PageResponse>(result.page);
}
