import { listFavoriteConversations } from "../lib/db.server";
import { apiJson, type FavoritesResponse } from "../lib/api-types";

/**
 * お気に入りの会話を全件返す。
 *
 * サイドバーの一覧は最新200件で切っていて、お気に入りはその外にも
 * ある。シェルのローダーには件数だけを載せ、「お気に入り」を開いた
 * ときにここから中身を取る（全ページの土台に全件を載せない）。
 */
export async function loader() {
  const conversations = await listFavoriteConversations();
  return apiJson<FavoritesResponse>(
    { conversations },
    { headers: { "Cache-Control": "no-store" } },
  );
}
