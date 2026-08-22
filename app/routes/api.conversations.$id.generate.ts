import type { Route } from "./+types/api.conversations.$id.generate";
import { cloudflareContext } from "../lib/cloudflare-context";
import {
  beginGeneration,
  getAppSettings,
  getConversation,
  undoGeneration,
} from "../lib/db.server";
import { readRetryConfig } from "../lib/retry";
import { checkMonthlyLimit, limitMessage } from "../lib/limit.server";
import type { ChatMessage } from "../lib/openrouter.server";
import type { ParamsState } from "../lib/params";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../lib/r2.server";
import { apiError, apiJson, requireMethod, type GenerateResponse } from "../lib/api-types";

interface GenerateBody {
  model: string;
  web?: boolean;
  /**
   * Webをサーバーツール（openrouter:web_fetch / web_search）として渡すか。
   * tool calling 対応モデルでしか使えないので、モデル一覧の
   * supported_parameters を見たクライアントが申告する。
   */
  webTools?: boolean;
  /** 画像を出力できるモデルか（OpenRouterでは modalities の指定が要る）。 */
  imageOutput?: boolean;
  params?: ParamsState | null;
  /** LLMへ送る完全なメッセージ列（システムプロンプト含む）。 */
  messages: ChatMessage[];
  /** 新しいメッセージ列を挿入する親（null = ルート）。 */
  parentId?: string | null;
  /** 新規のユーザー発言。再生成のときは null。 */
  userContent?: string | null;
  /** 新規のユーザー発言に添付する画像（アップロード済みの添付ID）。 */
  userAttachmentIds?: string[];
}

/**
 * サーバー側生成の開始。ユーザーメッセージと生成中プレースホルダを保存し、
 * 生成ジョブをDurable Objectのアラームに登録して即座に応答を返す。
 * 生成過程はすべての画面がポーリング（/messages/:mid）で閲覧する。
 */
export async function action({ request, params, context }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;

  let body: GenerateBody;
  try {
    body = (await request.json()) as GenerateBody;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    return apiError("model と messages は必須です", 400);
  }

  const conversation = await getConversation(params.id);
  if (!conversation) {
    return apiError("会話が見つかりません", 404);
  }

  // 月間の上限。ここは生成が始まる唯一の入口なので、門はここに置く
  // （クライアント側の無効化は見た目だけで、信用しない）。
  // 「成功するまで生成」は1回の依頼で何度も投げるため、走り出したあとの
  // 歯止めは発射ループの側にも要る（generation.server.ts）
  const limit = await checkMonthlyLimit();
  if (limit.blocked) {
    return apiError(limitMessage(limit), 402);
  }

  // 「成功するまで生成」の設定。天井はアプリ設定側で決まるので、
  // クライアントの値は信用せずここで通す
  // 成功の判定が「画像が返ったか」なので、画像を出せるモデル以外では
  // 何度投げても成功しない。モデル側の条件もここで見る
  const settings = await getAppSettings();
  const retry =
    body.imageOutput === true
      ? readRetryConfig(body.params, settings.retryAttemptCeiling)
      : null;

  const { userMessageId, assistantMessageId } = await beginGeneration({
    conversationId: params.id,
    parentId: body.parentId ?? null,
    userContent: body.userContent ?? null,
    userAttachmentIds: Array.isArray(body.userAttachmentIds)
      ? body.userAttachmentIds.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
      : [],
    modelId: body.model,
  });

  // 生成ジョブをDurable Objectのアラームに登録（ブラウザ切断後も完了まで継続）
  const { env } = context.get(cloudflareContext);
  const stub = env.GENERATOR.get(env.GENERATOR.idFromName(assistantMessageId));
  const doResponse = await stub.fetch("https://generator/start", {
    method: "POST",
    body: JSON.stringify({
      conversationId: params.id,
      assistantMessageId,
      model: body.model,
      web: body.web === true,
      webTools: body.webTools === true,
      imageOutput: body.imageOutput === true,
      retry: retry ?? undefined,
      paramsState: body.params ?? null,
      messages: body.messages.map((m) => ({
        role: m.role,
        content: m.content,
        attachmentIds: Array.isArray(m.attachmentIds)
          ? m.attachmentIds.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
          : undefined,
      })),
    }),
  });

  if (!doResponse.ok) {
    // 保存だけが残ると、送り直すたびに同じ発言が木へ積まれる。
    // 始める前の状態へ戻してから返す
    await undoGeneration({
      conversationId: params.id,
      userMessageId,
      assistantMessageId,
      previousLeafId: conversation.current_leaf_message_id,
    }).catch(() => {
      // 取り消しにも失敗したら、残ってしまうことは避けられない。
      // 少なくともログには残す
      console.error("[gen] 生成の開始を取り消せませんでした", {
        conversationId: params.id,
        assistantMessageId,
      });
    });
    return apiError("生成の開始に失敗しました", 502);
  }

  return apiJson<GenerateResponse>({ userMessageId, assistantMessageId });
}
