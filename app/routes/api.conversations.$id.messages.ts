import type { Route } from "./+types/api.conversations.$id.messages";
import {
  appendMessages,
  getConversation,
  type NewMessage,
} from "../lib/db.server";

interface Body {
  parentId: string | null;
  messages: NewMessage[];
}

const VALID_ROLES = new Set(["user", "assistant", "system"]);

/**
 * Appends messages under parentId and moves the conversation's current leaf.
 * Appending under an older message (not the current leaf) creates a new
 * branch — the previous children remain in the tree as siblings.
 */
export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.some(
      (m) => !VALID_ROLES.has(m.role) || typeof m.content !== "string",
    )
  ) {
    return Response.json({ error: "messages が不正です" }, { status: 400 });
  }

  const conversation = await getConversation(params.id);
  if (!conversation) {
    return Response.json({ error: "会話が見つかりません" }, { status: 404 });
  }

  const ids = await appendMessages({
    conversationId: params.id,
    parentId: body.parentId ?? null,
    messages: body.messages,
  });
  return Response.json({ ids });
}
