import { openRouterChatRequest, type ChatMessage } from "./openrouter.server";
import { buildGenerationPayload, type ParamsState } from "./params";
import { finalizeGeneration, flushGeneration } from "./db.server";

/**
 * サーバー側生成。
 *
 * 上流（OpenRouter）のSSEを読みながら、
 *  - クライアントへそのまま中継し（接続が生きている間だけ）、
 *  - 一定間隔でD1へ部分保存する。
 * クライアントが切断されても ctx.waitUntil 経由で読み取りを続けるため、
 * リロードや別端末からはD1のポーリングで生成過程を閲覧できる。
 */

const FLUSH_INTERVAL_MS = 900;

export interface GenerationHandle {
  /** クライアントへ中継するSSEストリーム。 */
  stream: ReadableStream<Uint8Array>;
  /** ctx.waitUntil に渡す、生成完了までのプロミス。 */
  done: Promise<void>;
}

export async function startGeneration(params: {
  assistantMessageId: string;
  model: string;
  web: boolean;
  paramsState: ParamsState | null;
  messages: ChatMessage[];
}): Promise<{ error: string; status: number } | GenerationHandle> {
  const model = params.web ? `${params.model}:online` : params.model;
  const upstream = await openRouterChatRequest({
    model,
    messages: params.messages,
    stream: true,
    usage: { include: true },
    ...buildGenerationPayload(params.paramsState),
  });

  if (!upstream.ok || !upstream.body) {
    let detail = "";
    try {
      const err = (await upstream.json()) as { error?: { message?: string } };
      detail = err.error?.message ?? "";
    } catch {
      // ステータスコードだけで十分
    }
    const message = detail || `OpenRouter APIエラー (${upstream.status})`;
    await finalizeGeneration(params.assistantMessageId, {
      content: "",
      reasoning: null,
      usageJson: null,
      status: "error",
      error: message,
    });
    return { error: message, status: upstream.status };
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  return {
    stream: readable,
    done: pump(upstream.body, writer, params.assistantMessageId),
  };
}

async function pump(
  body: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  messageId: string,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usageJson: string | null = null;
  let finishReason: string | undefined;
  let clientGone = false;
  let stopped = false;
  let lastFlush = Date.now();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!clientGone && value) {
        try {
          await writer.write(value);
        } catch {
          // クライアント切断。以降はD1への保存のみ続ける
          clientGone = true;
        }
      }

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
            });
          }
        } catch {
          // 不正なチャンクは無視
        }
      }

      if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
        lastFlush = Date.now();
        const { stopRequested } = await flushGeneration(messageId, {
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
  await finalizeGeneration(messageId, {
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

  try {
    await writer.close();
  } catch {
    // クライアント切断済みなら無視
  }
}
