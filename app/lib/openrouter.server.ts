import { env } from "cloudflare:workers";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const POE_BASE = "https://api.poe.com/v1";

/** Poeモデルは "poe:" プレフィックス付きのIDで扱う。 */
export const POE_PREFIX = "poe:";

/** Subset of the OpenRouter model metadata we expose to the client. */
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  /** USD per input token (as string, e.g. "0.000003"). */
  promptPrice: string;
  /** USD per output token. */
  completionPrice: string;
  /** e.g. ["text", "image"] */
  inputModalities: string[];
  /** OpenRouterが返す、このモデルが対応する生成パラメータ名の一覧。 */
  supportedParameters: string[];
  /** 提供元。poe はサブスクのポイントで課金される。 */
  provider: "openrouter" | "poe";
  createdAt: number;
}

interface ModelsCache {
  models: ModelInfo[];
  fetchedAt: number;
}

const MODELS_TTL_MS = 60 * 60 * 1000; // 1 hour

// Module-level cache. Workers isolates are reused across requests, so this
// avoids hitting the models endpoint on every page view. Isolate eviction
// simply causes a refetch.
let modelsCache: ModelsCache | null = null;

/** Poeのモデル一覧。キー未設定・失敗時は空配列（Poe対応は任意機能）。 */
async function fetchPoeModels(): Promise<ModelInfo[]> {
  if (!env.POE_API_KEY) return [];
  try {
    const res = await fetch(`${POE_BASE}/models`, {
      headers: { Authorization: `Bearer ${env.POE_API_KEY}` },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Record<string, unknown>[] };
    return (body.data ?? []).map(
      (m): ModelInfo => ({
        id: `${POE_PREFIX}${String(m.id)}`,
        name: String(m.id),
        description: "Poe（サブスクのポイントで課金）",
        contextLength: 0,
        promptPrice: "0",
        completionPrice: "0",
        inputModalities: ["text"],
        // Poeはモデル別の対応パラメータを公開していないため空にする
        supportedParameters: [],
        provider: "poe",
        createdAt: Number(m.created ?? 0),
      }),
    );
  } catch {
    return [];
  }
}

export async function fetchModels(): Promise<ModelInfo[]> {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_TTL_MS) {
    return modelsCache.models;
  }

  const [res, poeModels] = await Promise.all([
    fetch(`${OPENROUTER_BASE}/models`),
    fetchPoeModels(),
  ]);
  if (!res.ok) {
    // Serve stale data instead of failing if we have any.
    if (modelsCache) return modelsCache.models;
    throw new Response(`OpenRouterのモデル一覧取得に失敗しました (${res.status})`, {
      status: 502,
    });
  }

  const body = (await res.json()) as { data: Record<string, unknown>[] };
  const models = body.data
    .map((m): ModelInfo => {
      const pricing = (m.pricing ?? {}) as Record<string, string>;
      const architecture = (m.architecture ?? {}) as Record<string, unknown>;
      return {
        id: String(m.id),
        name: String(m.name ?? m.id),
        description: String(m.description ?? ""),
        contextLength: Number(m.context_length ?? 0),
        promptPrice: pricing.prompt ?? "0",
        completionPrice: pricing.completion ?? "0",
        inputModalities: (architecture.input_modalities as string[]) ?? ["text"],
        supportedParameters: (m.supported_parameters as string[]) ?? [],
        provider: "openrouter" as const,
        createdAt: Number(m.created ?? 0),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  const merged = [
    ...models,
    ...poeModels.sort((a, b) => a.name.localeCompare(b.name)),
  ];
  modelsCache = { models: merged, fetchedAt: Date.now() };
  return merged;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * 添付画像の添付ID（ユーザーメッセージのみ）。
   * 送信直前にR2から読み出して data: URL へ展開する。
   */
  attachmentIds?: string[];
}

/** Cheap model used for auto-generating conversation titles. */
const TITLE_MODEL = "openai/gpt-4o-mini";

/**
 * Generates a short conversation title from the first exchange.
 * Returns null on any failure — a title is nice-to-have, never worth an error.
 */
export async function generateTitle(params: {
  userText: string;
  assistantText: string;
}): Promise<string | null> {
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TITLE_MODEL,
        messages: [
          {
            role: "user",
            content: `次の会話に、内容を要約した短いタイトルを付けてください。タイトルは15文字以内、会話と同じ言語で、タイトル文字列のみを出力してください。引用符や句点は不要です。\n\n---\nユーザー: ${params.userText.slice(0, 1000)}\n\nアシスタント: ${params.assistantText.slice(0, 1000)}`,
          },
        ],
        max_tokens: 50,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const title = body.choices?.[0]?.message?.content?.trim();
    if (!title) return null;
    return title.replace(/^["「『]|["」』]$/g, "").slice(0, 60);
  } catch {
    return null;
  }
}

/**
 * OpenRouterの chat/completions へのリクエスト。APIキーはサーバー側のみ。
 */
/** Poeの chat/completions（OpenAI互換）へのリクエスト。 */
export async function poeChatRequest(
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(`${POE_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.POE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function openRouterChatRequest(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      // Optional attribution headers recommended by OpenRouter.
      "HTTP-Referer": "https://github.com/rabi0424/chat_webui",
      "X-Title": "chat_webui",
    },
    body: JSON.stringify(body),
    signal,
  });
}
