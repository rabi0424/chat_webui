import type { Route } from "./+types/api.conversations.$id.stop";
import { getConversation, requestStop } from "../lib/db.server";

/** 生成中メッセージの停止を要求する（どの端末からでも有効）。 */
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
  await requestStop(params.id, body.messageId);
  return Response.json({ ok: true });
}
