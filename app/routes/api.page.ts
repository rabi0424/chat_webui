import type { Route } from "./+types/api.page";
import { apiError, apiJson, requireMethod, type PageResponse } from "../lib/api-types";
import { fetchPage } from "../lib/page-fetch.server";

/**
 * 入力欄に貼られたリンクの取り込み。
 *
 * 本文の取り出し（HTML → 読める文章）はブラウザ側でやるので、ここは
 * 取ってきたものをそのまま返す。取りに行ってよい宛先かの判定は
 * `page-fetch.server.ts`（転送の途中も1段ずつ見る）。
 *
 * バインディングには触らない（鍵も D1 も R2 も要らない）。
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

  const result = await fetchPage(body.url, new URL(request.url).host);
  if (!result.ok) return apiError(result.error, result.status);
  return apiJson<PageResponse>(result.page);
}
