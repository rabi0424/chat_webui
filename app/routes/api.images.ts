import type { Route } from "./+types/api.images";
import { listGeneratedImages } from "../lib/db.server";

/** 生成画像一覧の続き読み（?before=<created_at>）。 */
export async function loader({ request }: Route.LoaderArgs) {
  const before = Number(new URL(request.url).searchParams.get("before"));
  const images = await listGeneratedImages({
    limit: 60,
    before: Number.isFinite(before) && before > 0 ? before : undefined,
  });
  return Response.json({ images }, { headers: { "Cache-Control": "no-store" } });
}
