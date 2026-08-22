import type { Route } from "./+types/api.conversations";
import {
  createConversation,
  getBot,
  updateConversationParams,
} from "../lib/db.server";
import { MAX_TITLE_LENGTH } from "../lib/constants";
import { apiError, apiJson, requireMethod, type CreateConversationResponse } from "../lib/api-types";

export async function action({ request }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;

  let body: {
    title?: string;
    modelId?: string;
    botId?: string;
    params?: Record<string, unknown> | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (!body.modelId) {
    return apiError("modelId は必須です", 400);
  }

  // ボット開始時はサーバー側で現在のボット設定をスナップショットする
  const bot = body.botId ? await getBot(body.botId) : null;

  const conversation = await createConversation({
    title: (body.title ?? "新しいチャット").slice(0, MAX_TITLE_LENGTH),
    modelId: body.modelId,
    bot,
  });

  // 開始前に⚙パネルで調整済みの場合はそちらを優先して保存
  if (body.params && Object.keys(body.params).length > 0) {
    await updateConversationParams(
      conversation.id,
      JSON.stringify(body.params),
    );
  }
  return apiJson<CreateConversationResponse>({ id: conversation.id });
}
