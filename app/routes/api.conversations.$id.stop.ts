import type { Route } from "./+types/api.conversations.$id.stop";
import { getConversation, requestStop } from "../lib/db.server";
import { apiError, requireMethod } from "../lib/api-types";

/** 生成中メッセージの停止を要求する（どの端末からでも有効）。 */
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
  await requestStop(params.id, body.messageId);
  return Response.json({ ok: true });
}
