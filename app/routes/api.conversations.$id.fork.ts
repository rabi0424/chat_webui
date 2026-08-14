import type { Route } from "./+types/api.conversations.$id.fork";
import { forkConversation, getConversation } from "../lib/db.server";

/** POST: 指定メッセージまでの履歴をコピーした独立の新会話を作る。 */
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
  const newId = await forkConversation(conversation, body.messageId);
  if (!newId) {
    return Response.json({ error: "メッセージが見つかりません" }, { status: 404 });
  }
  return Response.json({ id: newId });
}
