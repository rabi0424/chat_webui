import type { Route } from "./+types/api.conversations.$id.title";
import {
  getConversation,
  recordStandaloneUsage,
  updateConversationTitle,
} from "../lib/db.server";
import { generateTitle } from "../lib/openrouter.server";
import { apiError, requireMethod } from "../lib/api-types";

interface Body {
  userText: string;
  assistantText: string;
}

export async function action({ request, params }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return apiError("不正なリクエストです", 400);
  }

  const conversation = await getConversation(params.id);
  if (!conversation) {
    return apiError("会話が見つかりません", 404);
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
