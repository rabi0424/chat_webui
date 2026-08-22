import type { Route } from "./+types/api.conversations.$id";
import {
  deleteConversation,
  getConversation,
  markConversationRead,
  updateConversationMeta,
  updateConversationModel,
  updateConversationParams,
} from "../lib/db.server";
import { MAX_TITLE_LENGTH } from "../lib/constants";
import { apiError, requireMethod } from "../lib/api-types";

export async function action({ request, params }: Route.ActionArgs) {
  // 扱えるメソッドかを先に見る。存在の確認を先にすると、知らない
  // メソッドで存在しないIDを叩いたときに 405 ではなく 404 が返り、
  // 「そのIDが無い」のか「その操作ができない」のか区別が付かない
  const bad = requireMethod(request, ["DELETE", "PATCH"]);
  if (bad) return bad;

  const conversation = await getConversation(params.id);
  if (!conversation) {
    return apiError("会話が見つかりません", 404);
  }

  if (request.method === "DELETE") {
    await deleteConversation(params.id);
    return Response.json({ ok: true });
  }

  // ここまで来たら PATCH（他は上で弾いている）

  let body: {
    modelId?: string;
    params?: Record<string, unknown> | null;
    title?: string;
    pinned?: boolean;
    favorite?: boolean;
    folderId?: string | null;
    /** true で既読にする。 */
    read?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (body.modelId) {
    await updateConversationModel(params.id, body.modelId);
  }
  if (
    body.title !== undefined ||
    body.pinned !== undefined ||
    body.favorite !== undefined ||
    body.folderId !== undefined
  ) {
    await updateConversationMeta(params.id, {
      title: body.title?.trim().slice(0, MAX_TITLE_LENGTH),
      pinned: body.pinned,
      favorite: body.favorite,
      folderId: body.folderId,
    });
  }
  if (body.read) {
    await markConversationRead(params.id);
  }
  if (body.params !== undefined) {
    await updateConversationParams(
      params.id,
      body.params && Object.keys(body.params).length > 0
        ? JSON.stringify(body.params)
        : null,
    );
  }
  return Response.json({ ok: true });
  

}
