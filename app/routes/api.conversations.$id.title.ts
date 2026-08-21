import type { Route } from "./+types/api.conversations.$id.title";
import {
  getConversation,
  recordStandaloneUsage,
  updateConversationTitle,
} from "../lib/db.server";
import { generateTitle } from "../lib/openrouter.server";

interface Body {
  userText: string;
  assistantText: string;
}

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

  const conversation = await getConversation(params.id);
  if (!conversation) {
    return Response.json({ error: "会話が見つかりません" }, { status: 404 });
  }

  const result = await generateTitle({
    userText: body.userText ?? "",
    assistantText: body.assistantText ?? "",
  });
  // タイトルが取れなくても投げた分は課金される。先に台帳へ載せる
  await recordStandaloneUsage({
    kind: "title",
    modelId: result.modelId,
    costUsd: result.costUsd,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  });
  if (result.title) {
    await updateConversationTitle(params.id, result.title);
  }
  return Response.json({ title: result.title });
}
