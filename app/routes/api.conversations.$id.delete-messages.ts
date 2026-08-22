import type { Route } from "./+types/api.conversations.$id.delete-messages";
import {
  deleteMessages,
  getConversation,
  getConversationPath,
} from "../lib/db.server";
import { toUiMessage } from "../lib/serialize.server";
import { apiError, requireMethod } from "../lib/api-types";

/** メッセージの一括削除。削除後の表示パスを返す。 */
export async function action({ request, params }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;
  let body: { ids?: string[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return apiError("ids は必須です", 400);
  }
  const conversation = await getConversation(params.id);
  if (!conversation) {
    return apiError("会話が見つかりません", 404);
  }

  await deleteMessages(params.id, body.ids.slice(0, 500));

  const updated = await getConversation(params.id);
  const path = updated ? await getConversationPath(updated) : [];
  return Response.json({ messages: path.map(toUiMessage) });
}
