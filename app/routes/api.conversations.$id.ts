import type { Route } from "./+types/api.conversations.$id";
import {
  deleteConversation,
  getConversation,
  updateConversationModel,
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
    let body: { modelId?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "不正なリクエストです" }, { status: 400 });
    }
    if (body.modelId) {
      await updateConversationModel(params.id, body.modelId);
    }
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Method Not Allowed" }, { status: 405 });
}
