import type { Route } from "./+types/api.conversations.$id.context";
import {
  getConversation,
  getConversationPath,
  setContextBoundary,
} from "../lib/db.server";
import { toUiMessage } from "../lib/serialize.server";
import { apiError, requireMethod } from "../lib/api-types";

/**
 * POST: コンテキストの境界線を立てる / 解除する。
 *
 * 立てたメッセージまで（それ自身を含む）は以後の生成でモデルへ送らない。
 * 履歴は一切消さないので、解除すれば元どおり全部が文脈に戻る。
 * 更新後のパスをそのまま返し、クライアントは再取得せずに反映できる。
 */
export async function action({ request, params }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;
  let body: { messageId?: string; enabled?: boolean };
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

  const ok = await setContextBoundary(
    params.id,
    body.messageId,
    body.enabled !== false,
  );
  if (!ok) {
    return apiError("メッセージが見つかりません", 404);
  }

  const path = await getConversationPath(conversation);
  return Response.json({ messages: path.map(toUiMessage) });
}
