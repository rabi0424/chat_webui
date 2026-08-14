import type { Route } from "./+types/api.conversations.$id.path";
import {
  getConversation,
  getConversationPath,
  switchToBranch,
} from "../lib/db.server";
import { toUiMessage } from "../lib/serialize.server";

/** GET: 現在表示中のパスを返す（ページャ情報付き）。 */
export async function loader({ params }: Route.LoaderArgs) {
  const conversation = await getConversation(params.id);
  if (!conversation) {
    return Response.json({ error: "会話が見つかりません" }, { status: 404 });
  }
  const path = await getConversationPath(conversation);
  return Response.json({ messages: path.map(toUiMessage) });
}

/** POST: 指定メッセージのブランチへ切り替え、新しいパスを返す。 */
export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }
  let body: { messageId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  if (!body.messageId) {
    return Response.json({ error: "messageId は必須です" }, { status: 400 });
  }

  const conversation = await getConversation(params.id);
  if (!conversation) {
    return Response.json({ error: "会話が見つかりません" }, { status: 404 });
  }
  const ok = await switchToBranch(conversation, body.messageId);
  if (!ok) {
    return Response.json({ error: "メッセージが見つかりません" }, { status: 404 });
  }

  const updated = await getConversation(params.id);
  const path = await getConversationPath(updated!);
  return Response.json({ messages: path.map(toUiMessage) });
}
