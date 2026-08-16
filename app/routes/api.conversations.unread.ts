import { listUnreadConversationIds } from "../lib/db.server";

/**
 * 未読の会話ID。
 *
 * 応答はサーバー側で進むため、別の画面にいるあいだに完成しても
 * クライアントは気づけない。サイドバーはこれを短い間隔で引いて印を更新する。
 */
export async function loader() {
  return Response.json(
    { ids: await listUnreadConversationIds() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
