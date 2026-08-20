import type { Route } from "./+types/api.images";
import { listGeneratedImages } from "../lib/db.server";
import { apiJson, type ImagesResponse } from "../lib/api-types";

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
  return apiJson<ImagesResponse>(
    { images },
    { headers: { "Cache-Control": "no-store" } },
  );
}
