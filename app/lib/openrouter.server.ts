import { env } from "cloudflare:workers";
import { poeSupportedParameters } from "./params";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const POE_BASE = "https://api.poe.com/v1";
/** Poe Usage API（残高・ポイント履歴）。/v1 の外に生えている。 */
const POE_USAGE_BASE = POE_BASE.replace(/\/v1$/, "") + "/usage";

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
  /** e.g. ["text", "image"]。画像生成ボットの判別に使う。 */
  outputModalities: string[];
  /** OpenRouterが返す、このモデルが対応する生成パラメータ名の一覧。 */
  supportedParameters: string[];
  /**
   * Poe: このモデルが受け付ける reasoning_effort の値（Poeの申告順）。
   * 空/未定義なら思考の強さを指定できない。
   */
  reasoningEfforts?: string[];
  /** Poe: thinking_budget（思考に使うトークン数）の許容範囲。 */
  reasoningBudget?: { min: number; max: number };
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

/** 数値として読めれば返す。読めなければ undefined。 */
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Poeの pricing は100万トークン単価。ModelInfo は1トークン単価の文字列。 */
function perMillionToPerToken(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return String(n / 1_000_000);
}

/** Poeが値を明示しないときに出す思考の強さ（どのモデルでも概ね通る3段階）。 */
const DEFAULT_EFFORTS = ["low", "medium", "high"];

/**
 * Poeの reasoning_effort 対応値を正規化する。
 *
 * supports_reasoning_effort は真偽値のことも、許容値の配列のこともある
 * （例: grok-3-mini は ["low","high"]）。
 */
function parseEfforts(v: unknown): string[] | undefined {
  if (v === true) return DEFAULT_EFFORTS;
  if (Array.isArray(v)) {
    const list = v.filter((x): x is string => typeof x === "string" && x !== "");
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

/**
 * Poeのモデル一覧。キー未設定・失敗時は空配列（Poe対応は任意機能）。
 *
 * Poeの /v1/models は OpenRouter とはフィールド名が違うだけで、
 * コンテキスト長・価格・画像対応・thinking対応をきちんと返す。
 * 別名（context_window が数値だったりオブジェクトだったり、
 * architecture.input_modalities 側にモダリティが入っていたり）が
 * あるため、両方見て埋める。
 */
async function fetchPoeModels(): Promise<ModelInfo[]> {
  if (!env.POE_API_KEY) return [];
  try {
    const res = await fetch(`${POE_BASE}/models`, {
      headers: { Authorization: `Bearer ${env.POE_API_KEY}` },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Record<string, unknown>[] };
    return (body.data ?? []).map((m): ModelInfo => {
      const architecture = (m.architecture ?? {}) as Record<string, unknown>;
      const pricing = (m.pricing ?? {}) as Record<string, unknown>;
      const reasoning = (m.reasoning ?? {}) as Record<string, unknown>;
      const ctxWindow = m.context_window as
        | Record<string, unknown>
        | number
        | null
        | undefined;
      const contextLength =
        num(ctxWindow) ??
        num((ctxWindow as Record<string, unknown> | null)?.context_length) ??
        num(m.context_length) ??
        0;

      const inputModalities =
        (architecture.input_modalities as string[] | undefined) ??
        (m.supports_images === true ? ["text", "image"] : ["text"]);
      const outputModalities =
        (m.output_modalities as string[] | undefined) ??
        (architecture.output_modalities as string[] | undefined) ?? ["text"];

      const efforts = parseEfforts(reasoning.supports_reasoning_effort);
      const budgetRaw = (reasoning.budget ?? null) as Record<
        string,
        unknown
      > | null;
      const budgetMax = num(budgetRaw?.max_tokens);
      const reasoningBudget = budgetMax
        ? { min: num(budgetRaw?.min_tokens) ?? 0, max: budgetMax }
        : undefined;

      return {
        id: `${POE_PREFIX}${String(m.id)}`,
        name: String(m.display_name || m.id),
        description: "Poe（サブスクのポイントで課金）",
        contextLength,
        promptPrice: perMillionToPerToken(pricing.input_per_million) ?? "0",
        completionPrice:
          perMillionToPerToken(pricing.output_per_million) ?? "0",
        inputModalities,
        outputModalities,
        // Poeが対応を明言しているものだけを載せる（詳細は params.ts）
        supportedParameters: poeSupportedParameters({
          efforts,
          reasoningBudget,
          outputModalities,
        }),
        reasoningEfforts: efforts,
        reasoningBudget,
        provider: "poe",
        createdAt: Number(m.created ?? 0),
      };
    });
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
        outputModalities: (architecture.output_modalities as string[]) ?? [
          "text",
        ],
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

function parsePoeTime(v: unknown): number | null {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export interface PoePointsHit {
  points: number;
  costUsd?: number;
}

/**
 * Poeのポイント履歴から、指定ボットの sinceMs 以降の消費を探す。
 *
 * PoeのOpenAI互換レスポンスにはポイント消費が載らないため、
 * 生成完了後に Usage API（/usage/points_history）を照会して
 * 直近エントリを突き合わせる。履歴は新しい順で返る前提で、
 * sinceMs より明確に古いエントリに達したら打ち切る。
 */
export async function fetchPoeRecentPoints(
  botName: string,
  sinceMs: number,
): Promise<PoePointsHit | null> {
  if (!env.POE_API_KEY) return null;
  try {
    const res = await fetch(`${POE_USAGE_BASE}/points_history`, {
      headers: { Authorization: `Bearer ${env.POE_API_KEY}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const entries = (
      Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []
    ) as Record<string, unknown>[];
    for (const e of entries) {
      const t = parsePoeTime(e.time);
      if (t != null && t < sinceMs - 60_000) break;
      if (String(e.bot_name ?? "").toLowerCase() !== botName.toLowerCase()) {
        continue;
      }
      const points = Number(e.cost_points);
      if (!Number.isFinite(points)) continue;
      const costUsd = Number(e.cost_usd);
      return {
        points,
        costUsd: Number.isFinite(costUsd) ? costUsd : undefined,
      };
    }
    return null;
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
