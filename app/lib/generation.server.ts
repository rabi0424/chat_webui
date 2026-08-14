import { openRouterChatRequest, type ChatMessage } from "./openrouter.server";
import { buildGenerationPayload, type ParamsState } from "./params";
import { finalizeGeneration, flushGeneration } from "./db.server";

/**
 * サーバー側生成のジョブ実行。
 *
 * Durable Object のアラームハンドラ内から呼ばれ、上流（OpenRouter）の
 * SSEを読みながら一定間隔でD1へ部分保存し、終了時に確定させる。
 * クライアントへの直接中継は行わず、すべての画面がD1のポーリングで
 * 生成過程を閲覧する（イベントとして完了まで実行が保証される）。
 */

const FLUSH_INTERVAL_MS = 900;

/**
 * プロンプトキャッシングの適用。
 *
 * OpenAI / Gemini / DeepSeek などは自動でキャッシュされるが、
 * Anthropic (Claude) は cache_control ブレークポイントの明示が必要。
 * チャットは毎ターン同じ履歴を先頭から送り直すため、
 * システムプロンプトと直近2つのユーザーメッセージに印を付けると
 * 前ターンまでの前置きがキャッシュ読取（0.1倍課金）になる。
 */
function applyPromptCaching(
  model: string,
  messages: ChatMessage[],
): unknown[] {
  if (!model.startsWith("anthropic/")) return messages;

  const marked = new Set<number>();
  messages.forEach((m, i) => {
    if (m.role === "system") marked.add(i);
  });
  let userMarks = 0;
  for (let i = messages.length - 1; i >= 0 && userMarks < 2; i--) {
    if (messages[i].role === "user") {
      marked.add(i);
      userMarks++;
    }
  }

  return messages.map((m, i) =>
    marked.has(i)
      ? {
          role: m.role,
          content: [
            {
              type: "text",
              text: m.content,
              cache_control: { type: "ephemeral" },
            },
          ],
        }
      : m,
  );
}

export interface GenerationJob {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  web: boolean;
  paramsState: ParamsState | null;
  messages: ChatMessage[];
}

/** 例外を投げず、必ずメッセージ行を確定させて終了する。 */
export async function runGenerationJob(job: GenerationJob): Promise<void> {
  const model = job.web ? `${job.model}:online` : job.model;

  let upstream: Response;
  try {
    upstream = await openRouterChatRequest({
      model,
      messages: applyPromptCaching(job.model, job.messages),
      stream: true,
      usage: { include: true },
      ...buildGenerationPayload(job.paramsState),
    });
  } catch (e) {
    await finalizeGeneration(job.assistantMessageId, {
      content: "",
      reasoning: null,
      usageJson: null,
      status: "error",
      error: `OpenRouterへの接続に失敗しました: ${(e as Error).message}`,
    });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    let detail = "";
    try {
      const err = (await upstream.json()) as { error?: { message?: string } };
      detail = err.error?.message ?? "";
    } catch {
      // ステータスコードだけで十分
    }
    await finalizeGeneration(job.assistantMessageId, {
      content: "",
      reasoning: null,
      usageJson: null,
      status: "error",
      error: detail || `OpenRouter APIエラー (${upstream.status})`,
    });
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usageJson: string | null = null;
  let finishReason: string | undefined;
  let stopped = false;
  let lastFlush = Date.now();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data: ")) continue;
        const data = line.slice("data: ".length);
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as {
            choices?: {
              delta?: { content?: string; reasoning?: string | null };
              finish_reason?: string | null;
            }[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              cost?: number;
              prompt_tokens_details?: { cached_tokens?: number };
              completion_tokens_details?: { reasoning_tokens?: number };
            };
          };
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (typeof choice?.delta?.content === "string") {
            content += choice.delta.content;
          }
          if (typeof choice?.delta?.reasoning === "string") {
            reasoning += choice.delta.reasoning;
          }
          if (chunk.usage) {
            usageJson = JSON.stringify({
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              cost: chunk.usage.cost,
              cachedTokens:
                chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined,
              reasoningTokens:
                chunk.usage.completion_tokens_details?.reasoning_tokens ??
                undefined,
            });
          }
        } catch {
          // 不正なチャンクは無視
        }
      }

      if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
        lastFlush = Date.now();
        const { stopRequested } = await flushGeneration(job.assistantMessageId, {
          content,
          reasoning: reasoning || null,
        });
        if (stopRequested) {
          stopped = true;
          try {
            await reader.cancel();
          } catch {
            // 既に閉じている場合は無視
          }
          break;
        }
      }
    }
  } catch {
    // 上流の切断・エラー: ここまでの内容で確定する
  }

  const empty = content === "";
  await finalizeGeneration(job.assistantMessageId, {
    content,
    reasoning: reasoning || null,
    usageJson,
    status: empty ? "error" : "done",
    error: empty
      ? stopped
        ? "生成開始直後に停止されました"
        : `モデルから本文のない応答が返りました${
            finishReason ? `（finish_reason: ${finishReason}）` : ""
          }`
      : null,
  });
}
