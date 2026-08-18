import type { Route } from "./+types/api.conversations.$id.context";
import {
  getConversation,
  getConversationPath,
  setContextBoundary,
} from "../lib/db.server";
import { toUiMessage } from "../lib/serialize.server";

/**
 * POST: コンテキストの境界線を立てる / 解除する。
 *
 * 立てたメッセージまで（それ自身を含む）は以後の生成でモデルへ送らない。
 * 履歴は一切消さないので、解除すれば元どおり全部が文脈に戻る。
 * 更新後のパスをそのまま返し、クライアントは再取得せずに反映できる。
 */
export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }
  let body: { messageId?: string; enabled?: boolean };
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

  const ok = await setContextBoundary(
    params.id,
    body.messageId,
    body.enabled !== false,
  );
  if (!ok) {
    return Response.json({ error: "メッセージが見つかりません" }, { status: 404 });
  }

  const path = await getConversationPath(conversation);
  return Response.json({ messages: path.map(toUiMessage) });
}
