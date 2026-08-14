import type { Route } from "./+types/api.conversations.$id.delete-messages";
import {
  deleteMessages,
  getConversation,
  getConversationPath,
} from "../lib/db.server";
import { toUiMessage } from "../lib/serialize.server";

/** メッセージの一括削除。削除後の表示パスを返す。 */
export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }
  let body: { ids?: string[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return Response.json({ error: "ids は必須です" }, { status: 400 });
  }
  const conversation = await getConversation(params.id);
  if (!conversation) {
    return Response.json({ error: "会話が見つかりません" }, { status: 404 });
  }

  await deleteMessages(params.id, body.ids.slice(0, 500));

  const updated = await getConversation(params.id);
  const path = updated ? await getConversationPath(updated) : [];
  return Response.json({ messages: path.map(toUiMessage) });
}
