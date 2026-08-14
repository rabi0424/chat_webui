import type { Route } from "./+types/api.search";
import { searchConversations } from "../lib/db.server";

/** 会話検索（タイトル + 本文、"-語" で除外）。 */
export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (!q.trim()) return Response.json({ results: [] });
  const results = await searchConversations(q.slice(0, 200));
  return Response.json(
    { results },
    { headers: { "Cache-Control": "no-store" } },
  );
}
