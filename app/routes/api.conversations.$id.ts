import type { Route } from "./+types/api.conversations.$id";
import {
  deleteConversation,
  getConversation,
  markConversationRead,
  updateConversationMeta,
  updateConversationModel,
  updateConversationParams,
} from "../lib/db.server";

export async function action({ request, params }: Route.ActionArgs) {
  const conversation = await getConversation(params.id);
  if (!conversation) {
    return Response.json({ error: "会話が見つかりません" }, { status: 404 });
  }

  if (request.method === "DELETE") {
    await deleteConversation(params.id);
    return Response.json({ ok: true });
  }

  if (request.method === "PATCH") {
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
      return Response.json({ error: "不正なリクエストです" }, { status: 400 });
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
        title: body.title?.trim().slice(0, 60),
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

  return Response.json({ error: "Method Not Allowed" }, { status: 405 });
}
