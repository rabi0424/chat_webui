import type { Route } from "./+types/api.images.$id";
import { setImageFavorite } from "../lib/db.server";
import { apiError, requireMethod } from "../lib/api-types";

/** 画像のお気に入り切り替え。 */
export async function action({ request, params }: Route.ActionArgs) {
  const bad = requireMethod(request, ["PATCH"]);
  if (bad) return bad;
  let body: { favorite?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (typeof body.favorite !== "boolean") {
    return apiError("favorite は必須です", 400);
  }
  const updated = await setImageFavorite(params.id, body.favorite);
  // 無いものを更新して成功を返すと、印を付けたつもりが付いていない、
  // という結果だけが残る
  if (!updated) {
    return apiError("画像が見つかりません", 404);
  }
  return Response.json({ ok: true });
}
