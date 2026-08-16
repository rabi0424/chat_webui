import {
  fetchPoeRecentPoints,
  openRouterChatRequest,
  poeChatRequest,
  POE_PREFIX,
  type ChatMessage,
} from "./openrouter.server";
import { buildGenerationPayload, type ParamsState } from "./params";
import { finalizeGeneration, flushGeneration, getAttachments } from "./db.server";
import { getFile, toBase64 } from "./r2.server";

/**
 * サーバー側生成のジョブ実行。
 *
 * Durable Object のアラームハンドラ内から呼ばれ、上流（OpenRouter）の
 * SSEを読みながら一定間隔でD1へ部分保存し、終了時に確定させる。
 * クライアントへの直接中継は行わず、すべての画面がD1のポーリングで
 * 生成過程を閲覧する（イベントとして完了まで実行が保証される）。
 */

const FLUSH_INTERVAL_MS = 900;

/** OpenAI互換のマルチモーダルコンテンツ要素。 */
type ContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | {
      type: "image_url";
      image_url: { url: string };
      cache_control?: { type: "ephemeral" };
    };

interface OutgoingMessage {
  role: string;
  content: string | ContentPart[];
}

/**
 * 添付画像を data: URL へ展開する。
 *
 * アプリは Cloudflare Access の背後にあり、外部（LLMプロバイダ）から
 * 画像URLを取得させられないため、実体をbase64で埋め込んで送る。
 * 読み出せなかった画像は黙って除外する（残りのやり取りは成立させる）。
 */
async function expandAttachments(
  messages: ChatMessage[],
): Promise<OutgoingMessage[]> {
  const out: OutgoingMessage[] = [];
  for (const m of messages) {
    if (!m.attachmentIds || m.attachmentIds.length === 0) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const rows = await getAttachments(m.attachmentIds);
    const parts: ContentPart[] = [];
    for (const a of rows) {
      try {
        const object = await getFile(a.r2_key);
        if (!object) continue;
        const url = `data:${a.mime_type};base64,${toBase64(
          await object.arrayBuffer(),
        )}`;
        parts.push({ type: "image_url", image_url: { url } });
      } catch {
        // 1枚読めなくても送信自体は続ける
      }
    }
    // 画像 → テキストの順（Anthropicの推奨。他社も同等に扱う）
    if (m.content) parts.push({ type: "text", text: m.content });
    out.push({
      role: m.role,
      content: parts.length > 0 ? parts : m.content,
    });
  }
  return out;
}

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
  messages: OutgoingMessage[],
): OutgoingMessage[] {
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

  return messages.map((m, i) => {
    if (!marked.has(i)) return m;
    // ブレークポイントは末尾の要素に置く（そこまでの全内容がキャッシュ対象）
    const parts: ContentPart[] =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : [...m.content];
    if (parts.length === 0) return m;
    parts[parts.length - 1] = {
      ...parts[parts.length - 1],
      cache_control: { type: "ephemeral" },
    };
    return { role: m.role, content: parts };
  });
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
  const startedAt = Date.now();
  const isPoe = job.model.startsWith(POE_PREFIX);
  const modelName = isPoe ? job.model.slice(POE_PREFIX.length) : job.model;
  // Web検索プラグイン（:online）はOpenRouter専用
  const model = !isPoe && job.web ? `${modelName}:online` : modelName;

  let upstream: Response;
  try {
    // 添付画像はここでR2から読み出して data: URL に展開する
    // （DOのストレージに実体を持ち込まないため、ジョブにはIDだけを載せている）
    const messages = await expandAttachments(job.messages);
    upstream = isPoe
      ? await poeChatRequest({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...buildGenerationPayload(job.paramsState, "poe"),
        })
      : await openRouterChatRequest({
          model,
          messages: applyPromptCaching(job.model, messages),
          stream: true,
          usage: { include: true },
          ...buildGenerationPayload(job.paramsState, "openrouter"),
        });
  } catch (e) {
    await finalizeGeneration(job.assistantMessageId, {
      content: "",
      reasoning: null,
      usageJson: null,
      status: "error",
      error: `${isPoe ? "Poe" : "OpenRouter"}への接続に失敗しました: ${(e as Error).message}`,
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
    // 上流が知らないパラメータを弾いたときは、英語のメッセージだけでは
    // 何を直せばいいか分からないので、設定パネルへ誘導する
    const hint = /unknown parameter|unsupported parameter/i.test(detail)
      ? "\nこのモデルが対応していないパラメータが含まれています。⚙の生成パラメータを見直してください。"
      : "";
    await finalizeGeneration(job.assistantMessageId, {
      content: "",
      reasoning: null,
      usageJson: null,
      status: "error",
      error:
        (detail || `${isPoe ? "Poe" : "OpenRouter"} APIエラー (${upstream.status})`) +
        hint,
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

  // Poe: ポイント消費はレスポンスに載らないため、Usage APIの履歴を
  // 突き合わせて usage に合流させる（履歴への反映が遅れることがあるので
  // 少し待ちながら数回試す。見つからなければ諦めて確定する）
  if (isPoe && content !== "") {
    for (const delay of [1200, 2500]) {
      await new Promise((r) => setTimeout(r, delay));
      const hit = await fetchPoeRecentPoints(modelName, startedAt);
      if (hit) {
        const base = usageJson
          ? (JSON.parse(usageJson) as Record<string, unknown>)
          : {};
        usageJson = JSON.stringify({
          ...base,
          points: hit.points,
          cost: hit.costUsd ?? base.cost,
        });
        break;
      }
    }
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
