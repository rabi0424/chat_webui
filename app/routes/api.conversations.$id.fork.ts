import type { Route } from "./+types/api.conversations.$id.fork";
import { forkConversation, getConversation } from "../lib/db.server";
import { apiError, requireMethod } from "../lib/api-types";

/** POST: 指定メッセージまでの履歴をコピーした独立の新会話を作る。 */
export async function action({ request, params }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;
  let body: { messageId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (!body.messageId) {
    return apiError("messageId は必須です", 400);
  }

  const conversation = await getConversation(params.id);
  if (!conversation) {
    return apiError("会話が見つかりません", 404);
  }
  const newId = await forkConversation(conversation, body.messageId);
  if (!newId) {
    return apiError("メッセージが見つかりません", 404);
  }
  return Response.json({ id: newId });
}
