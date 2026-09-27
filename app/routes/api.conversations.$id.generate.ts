import type { Route } from "./+types/api.conversations.$id.generate";
import { cloudflareContext } from "../lib/cloudflare-context";
import {
  beginGeneration,
  readGenerationStart,
  undoGeneration,
} from "../lib/db.server";
import { readRetryConfig } from "../lib/retry";
import { limitMessage, monthlyLimitVerdict } from "../lib/limit.server";
import { monthStartJst } from "../lib/usage";
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

  const parentId = body.parentId ?? null;
  const userContent = body.userContent ?? null;
  // 添付を紐づけるのは新しい発言があるときだけ（beginGeneration）。
  // 再生成で添付IDが来ても読まない
  const userAttachmentIds =
    userContent != null && Array.isArray(body.userAttachmentIds)
      ? body.userAttachmentIds.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
      : [];

  // 書く前に要るものは、1つの batch でまとめて読む。以前は会話・上限
  // （設定・台帳・為替）・設定をもう一度・繋ぎ先・添付を直列に読んでいて、
  // 送信してから上流へ投げるまでに D1 との往復が6〜7回並んでいた。
  // 読んだあとの判定の順（404 → 402 → 400）は以前のまま
  const now = Date.now();
  const start = await readGenerationStart({
    conversationId: params.id,
    parentId,
    userAttachmentIds,
    usageSince: monthStartJst(now),
  });
  const { conversation, settings } = start;
  if (!conversation) {
    return apiError("会話が見つかりません", 404);
  }

  // 月間の上限。ここは生成が始まる唯一の入口なので、門はここに置く
  // （クライアント側の無効化は見た目だけで、信用しない）。
  // 「成功するまで生成」は1回の依頼で何度も投げるため、走り出したあとの
  // 歯止めは発射ループの側にも要る（generation.server.ts）
  const limit = await monthlyLimitVerdict(start, now);
  if (limit.blocked) {
    return apiError(limitMessage(limit), 402);
  }

  // 「成功するまで生成」の設定。天井はアプリ設定側で決まるので、
  // クライアントの値は信用せずここで通す
  // 成功の判定が「画像が返ったか」なので、画像を出せるモデル以外では
  // 何度投げても成功しない。モデル側の条件もここで見る
  const retry =
    body.imageOutput === true
      ? readRetryConfig(body.params, settings.retryAttemptCeiling)
      : null;

  // 繋ぎ先（親）がこの会話のものかを、書く前に確かめる。確かめずに書くと、
  // 古いタブから消えたIDや別の会話のIDを渡されたときに**どこにも繋がって
  // いない発言**ができ、パスがそこで途切れて会話が2件のやり取りに置き換わった
  // ように見える（行は残るのに、画面から戻る手立てが無い）。
  // 「保存だけ」の入口（api.conversations.$id.messages.ts）と同じ確認。
  if (parentId != null && !start.parent) {
    return apiError("親メッセージが見つかりません", 400);
  }

  const { userMessageId, assistantMessageId } = await beginGeneration({
    conversationId: params.id,
    parentId,
    userContent,
    userAttachmentIds,
    // 上でもう読んである。渡さないと beginGeneration が読み直して往復が増える
    userAttachments: start.userAttachments,
    modelId: body.model,
  });

  // 開始に失敗したら、保存した発言とプレースホルダを取り消してから返す。
  // 保存だけが残ると、送り直すたびに同じ発言が木へ積まれる
  /**
   * 実行体を起こせなかったときの後始末。
   *
   * **理由を必ず添える。** 握り潰していたので、利用者からは
   * 「生成の開始に失敗しました」としか見えず、ストレージが一杯なのか
   * 実行体が落ちているのか、こちらから確かめる手立てが無かった。
   */
  const undoAndFail = async (reason: string) => {
    console.error("[gen] 生成の開始に失敗しました", {
      conversationId: params.id,
      assistantMessageId,
      reason,
    });
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
    return apiError(`生成の開始に失敗しました: ${reason}`, 502);
  };

  // 生成ジョブをDurable Objectのアラームに登録（ブラウザ切断後も完了まで継続）
  const { env } = context.get(cloudflareContext);
  const stub = env.GENERATOR.get(env.GENERATOR.idFromName(assistantMessageId));
  let doResponse: Response;
  try {
    doResponse = await stub.fetch("https://generator/start", {
      method: "POST",
      body: JSON.stringify({
        conversationId: params.id,
        assistantMessageId,
        model: body.model,
        web: body.web === true,
        webTools: body.webTools === true,
        imageOutput: body.imageOutput === true,
        retry: retry ?? undefined,
        workerConcurrency: settings.retryWorkerConcurrency,
        dailyDoSecondsBudget: settings.dailyDoSecondsBudget,
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
  } catch (e) {
    // DO の起動失敗・ストレージ書き込み失敗は**非ok応答ではなく例外**として
    // 現れる。下の !ok 分岐だけでは、この経路で発言と「生成中」の応答が
    // 永久に残っていた
    return undoAndFail(
      `実行体を起こせませんでした: ${(e as Error).message ?? e}`,
    );
  }

  if (!doResponse.ok) {
    const detail = await doResponse.text().catch(() => "");
    return undoAndFail(
      `実行体が ${doResponse.status} を返しました${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  return apiJson<GenerateResponse>({ userMessageId, assistantMessageId });
}
