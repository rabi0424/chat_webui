import type { Route } from "./+types/api.conversations";
import { createConversation } from "../lib/db.server";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  let body: { title?: string; modelId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  if (!body.modelId) {
    return Response.json({ error: "modelId は必須です" }, { status: 400 });
  }

  const conversation = await createConversation({
    title: (body.title ?? "新しいチャット").slice(0, 60),
    modelId: body.modelId,
  });
  return Response.json({ id: conversation.id });
}
