import type { Route } from "./+types/api.chat";
import {
  streamChatCompletion,
  type ChatMessage,
} from "../lib/openrouter.server";
import { buildGenerationPayload, type ParamsState } from "../lib/params";

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  web?: boolean;
  params?: Record<string, unknown>;
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

  // buildGenerationPayload が許可リスト検査と型変換を兼ねる
  const generation = buildGenerationPayload(body.params as ParamsState);

  return streamChatCompletion({
    model: body.model,
    messages: body.messages,
    web: body.web === true,
    generation,
    signal: request.signal,
  });
}
