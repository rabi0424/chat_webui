import type { Route } from "./+types/api.conversations";
import {
  createConversation,
  getBot,
  updateConversationParams,
} from "../lib/db.server";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  let body: {
    title?: string;
    modelId?: string;
    botId?: string;
    params?: Record<string, unknown> | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  if (!body.modelId) {
    return Response.json({ error: "modelId は必須です" }, { status: 400 });
  }

  // ボット開始時はサーバー側で現在のボット設定をスナップショットする
  const bot = body.botId ? await getBot(body.botId) : null;

  const conversation = await createConversation({
    title: (body.title ?? "新しいチャット").slice(0, 60),
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
  return Response.json({ id: conversation.id });
}
