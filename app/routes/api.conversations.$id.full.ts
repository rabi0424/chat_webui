import type { Route } from "./+types/api.conversations.$id.full";
import { getConversationWithPath } from "../lib/db.server";
import { toUiMessage } from "../lib/serialize.server";

/**
 * GET: chat/:id のローダーと同じ形（会話+表示パス）を返す。
 * サイドバーの先読み（lib/chat-cache.ts）が使う。iOS Safari は
 * <link rel="prefetch"> を無視するため、React Router 標準の
 * prefetch ではデータの先読みができず、この自前の入口が要る。
 */
export async function loader({ params }: Route.LoaderArgs) {
  const found = await getConversationWithPath(params.id);
  if (!found) {
    return Response.json({ error: "会話が見つかりません" }, { status: 404 });
  }
  return Response.json({
    conversation: found.conversation,
    messages: found.path.map(toUiMessage),
  });
}
