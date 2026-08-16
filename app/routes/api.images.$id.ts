import type { Route } from "./+types/api.images.$id";
import { setImageFavorite } from "../lib/db.server";

/** 画像のお気に入り切り替え。 */
export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "PATCH" && request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }
  let body: { favorite?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  if (typeof body.favorite !== "boolean") {
    return Response.json({ error: "favorite は必須です" }, { status: 400 });
  }
  await setImageFavorite(params.id, body.favorite);
  return Response.json({ ok: true });
}
