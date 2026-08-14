import type { Route } from "./+types/api.conversations.$id.generate";
import { cloudflareContext } from "../lib/cloudflare-context";
import { beginGeneration, getConversation } from "../lib/db.server";
import { startGeneration } from "../lib/generation.server";
import type { ChatMessage } from "../lib/openrouter.server";
import type { ParamsState } from "../lib/params";

interface GenerateBody {
  model: string;
  web?: boolean;
  params?: ParamsState | null;
  /** LLMへ送る完全なメッセージ列（システムプロンプト含む）。 */
  messages: ChatMessage[];
  /** 新しいメッセージ列を挿入する親（null = ルート）。 */
  parentId?: string | null;
  /** 新規のユーザー発言。再生成のときは null。 */
  userContent?: string | null;
}

/**
 * サーバー側生成の開始。ユーザーメッセージと生成中プレースホルダを先に
 * 保存してからSSEを中継する。クライアントが切断しても waitUntil で
 * 生成と保存は続き、他の画面はポーリングで途中経過を閲覧できる。
 */
export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  let body: GenerateBody;
  try {
    body = (await request.json()) as GenerateBody;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json(
      { error: "model と messages は必須です" },
      { status: 400 },
    );
  }

  const conversation = await getConversation(params.id);
  if (!conversation) {
    return Response.json({ error: "会話が見つかりません" }, { status: 404 });
  }

  const { userMessageId, assistantMessageId } = await beginGeneration({
    conversationId: params.id,
    parentId: body.parentId ?? null,
    userContent: body.userContent ?? null,
    modelId: body.model,
  });

  const result = await startGeneration({
    assistantMessageId,
    model: body.model,
    web: body.web === true,
    paramsState: body.params ?? null,
    messages: body.messages,
  });

  if ("error" in result) {
    return Response.json(
      { error: result.error, userMessageId, assistantMessageId },
      { status: 502 },
    );
  }

  // クライアント切断後も生成・保存を続ける
  context.get(cloudflareContext).ctx.waitUntil(result.done);

  return new Response(result.stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-User-Message-Id": userMessageId ?? "",
      "X-Assistant-Message-Id": assistantMessageId,
    },
  });
}
