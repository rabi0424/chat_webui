import type { Route } from "./+types/api.images";
import { listGeneratedImages } from "../lib/db.server";

/** 生成画像一覧の続き読みと検索。 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const before = Number(url.searchParams.get("before"));
  const images = await listGeneratedImages({
    limit: 60,
    before: Number.isFinite(before) && before > 0 ? before : undefined,
    query: url.searchParams.get("q") ?? undefined,
    favoritesOnly: url.searchParams.get("favorites") === "1",
  });
  return Response.json({ images }, { headers: { "Cache-Control": "no-store" } });
}
