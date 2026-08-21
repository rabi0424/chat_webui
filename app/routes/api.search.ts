import type { Route } from "./+types/api.search";
import { searchConversations } from "../lib/db.server";
import { apiJson, type SearchResponse } from "../lib/api-types";

/** 会話検索（タイトル + 本文、"-語" で除外）。 */
export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (!q.trim()) return apiJson<SearchResponse>({ results: [] });
  const results = await searchConversations(q.slice(0, 200));
  return apiJson<SearchResponse>(
    { results },
    { headers: { "Cache-Control": "no-store" } },
  );
}
