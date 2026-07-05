import type { Route } from "./+types/api.chat";
import {
  streamChatCompletion,
  type ChatMessage,
} from "../lib/openrouter.server";

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json(
      { error: "model と messages は必須です" },
      { status: 400 },
    );
  }

  return streamChatCompletion({
    model: body.model,
    messages: body.messages,
    signal: request.signal,
  });
}
