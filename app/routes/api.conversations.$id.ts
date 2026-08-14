import type { Route } from "./+types/api.conversations.$id";
import { deleteConversation, getConversation } from "../lib/db.server";

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "DELETE") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }
  const conversation = await getConversation(params.id);
  if (!conversation) {
    return Response.json({ error: "会話が見つかりません" }, { status: 404 });
  }
  await deleteConversation(params.id);
  return Response.json({ ok: true });
}
