import { env } from "cloudflare:workers";
import { poeSupportedParameters } from "./params";
import { MAX_TITLE_LENGTH, TITLE_MODEL } from "./constants";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const POE_BASE = "https://api.poe.com/v1";
/** Poe Usage API（残高・ポイント履歴）。/v1 の外に生えている。 */
const POE_USAGE_BASE = POE_BASE.replace(/\/v1$/, "") + "/usage";

// Poeの接頭辞は共有の置き場に移した。ここからの再輸出は、既に
// このモジュール経由で読んでいる箇所を壊さないため
import { POE_PREFIX } from "./constants";
export { POE_PREFIX };

/**
 * Poeがモデルごとに公開する、そのボット固有のパラメータ。
 *
 * /v1/models の各モデルの `parameters` から作る。名前も選択肢もボット任せ
 * （画像サイズが `size` のボットもあれば `aspect_ratio` のボットもある）
 * なので、ここから⚙パネルの入力欄を組み立てる。
 */
export interface PoeBotParameter {
  name: string;
  /** 選択肢（schema.enum）。あれば選択式にする。 */
  options?: string[];
  /** 真偽値のパラメータか。 */
  isBoolean?: boolean;
  /** 数値のパラメータの範囲。 */
  min?: number;
  max?: number;
  integer?: boolean;
  /** Poeが申告する既定値（指定しなければこの値で動く）。 */
  defaultValue?: string | number | boolean;
  description?: string;
}

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
  /** Poe: このボット固有のパラメータ（画像サイズなど）。 */
  botParameters?: PoeBotParameter[];
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

/** 100万トークン単価 → 1トークン単価の文字列。 */
function perMillionToPerToken(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return String(n / 1_000_000);
}

/**
 * Poeの価格。OpenRouterと同じ1トークン単価の文字列
 * （pricing.prompt = "0.0000050505"）で返るが、
 * 100万トークン単価のフィールドで返る場合もあるため両方見る。
 */
function poePrice(perToken: unknown, perMillion: unknown): string | undefined {
  if (typeof perToken === "string" && Number(perToken) > 0) return perToken;
  const n = Number(perToken);
  if (Number.isFinite(n) && n > 0) return String(n);
  return perMillionToPerToken(perMillion);
}

/**
 * ボット固有パラメータの正規化。
 *
 * 実物: {"name":"size","schema":{"enum":["auto","1024x1024",…]},
 *        "default_value":"auto"}
 *      {"name":"use_mask","schema":{"type":"boolean"},
 *        "default_value":false,"description":"…"}
 * schema の形は今後増えうるので、解釈できないものは名前だけ残して
 * 自由入力として扱う（送信自体はできるようにしておく）。
 */
function parseBotParameters(v: unknown): PoeBotParameter[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PoeBotParameter[] = [];
  for (const item of v) {
    const p = item as Record<string, unknown> | null;
    const name = typeof p?.name === "string" ? p.name : "";
    if (!name) continue;
    const schema = (p?.schema ?? {}) as Record<string, unknown>;
    const def = p?.default_value;
    const enumValues = Array.isArray(schema.enum)
      ? schema.enum.filter((x): x is string => typeof x === "string")
      : undefined;
    const type = typeof schema.type === "string" ? schema.type : undefined;

    out.push({
      name,
      options: enumValues && enumValues.length > 0 ? enumValues : undefined,
      isBoolean: type === "boolean" || undefined,
      min: num(schema.minimum),
      max: num(schema.maximum),
      integer: type === "integer" || undefined,
      defaultValue:
        typeof def === "string" ||
        typeof def === "number" ||
        typeof def === "boolean"
          ? def
          : undefined,
      description:
        typeof p?.description === "string" ? p.description : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
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

      const metadata = (m.metadata ?? {}) as Record<string, unknown>;

      return {
        id: `${POE_PREFIX}${String(m.id)}`,
        name: String(metadata.display_name || m.display_name || m.id),
        description:
          typeof m.description === "string" && m.description
            ? m.description
            : "Poe（サブスクのポイントで課金）",
        contextLength,
        promptPrice: poePrice(pricing.prompt, pricing.input_per_million) ?? "0",
        completionPrice:
          poePrice(pricing.completion, pricing.output_per_million) ?? "0",
        inputModalities,
        outputModalities,
        // Poeが対応を明言しているものだけを載せる（詳細は params.ts）
        supportedParameters: poeSupportedParameters({ efforts, reasoningBudget }),
        reasoningEfforts: efforts,
        reasoningBudget,
        botParameters: parseBotParameters(m.parameters),
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

/** APIキーらしき値を伏せる（診断用の生JSONをそのまま返すため）。 */
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /key|secret|token|password/i.test(k) && typeof v === "string"
        ? "***"
        : redactSecrets(v);
    }
    return out;
  }
  return value;
}

export interface PoeProbeResult {
  endpoint: string;
  status: number | null;
  body?: unknown;
  error?: string;
}

/**
 * 特定のPoeボットについてPoeが返す情報を、そのまま見せる（診断用）。
 *
 * ボットが受け付けるパラメータ名（画像の縦横比など）は、モデル一覧にも
 * ドキュメント化されたエンドポイントにも載っていない。ただし公開されて
 * いないだけで返っている可能性はあるため、候補のエンドポイントを順に
 * 叩いて生のJSONを返す。ここに parameter_controls 相当が出てくるなら、
 * ⚙パネルの入力欄を自動生成できる。
 */
export async function probePoeBot(botName: string): Promise<PoeProbeResult[]> {
  if (!env.POE_API_KEY) {
    return [{ endpoint: "-", status: null, error: "POE_API_KEY が未設定です" }];
  }
  const headers = { Authorization: `Bearer ${env.POE_API_KEY}` };
  const name = encodeURIComponent(botName);
  const results: PoeProbeResult[] = [];

  for (const endpoint of [
    `${POE_BASE}/models/${name}`,
    `${POE_BASE.replace(/\/v1$/, "")}/bots/${name}`,
  ]) {
    try {
      const res = await fetch(endpoint, { headers });
      const text = await res.text();
      let body: unknown = text.slice(0, 20000);
      try {
        body = redactSecrets(JSON.parse(text));
      } catch {
        // JSONでなければ本文の先頭をそのまま見せる
      }
      results.push({ endpoint, status: res.status, body });
    } catch (e) {
      results.push({ endpoint, status: null, error: (e as Error).message });
    }
  }

  // モデル一覧に載っている当該ボットの行（一覧側にしかない項目の確認用）
  try {
    const res = await fetch(`${POE_BASE}/models`, { headers });
    const body = (await res.json()) as { data?: Record<string, unknown>[] };
    const hit = (body.data ?? []).find(
      (m) => String(m.id).toLowerCase() === botName.toLowerCase(),
    );
    results.push({
      endpoint: `${POE_BASE}/models → ${botName}`,
      status: res.status,
      body: hit ? redactSecrets(hit) : "一覧に見つかりませんでした",
    });
  } catch (e) {
    results.push({
      endpoint: `${POE_BASE}/models`,
      status: null,
      error: (e as Error).message,
    });
  }

  return results;
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

/**
 * Generates a short conversation title from the first exchange.
 * Returns null on any failure — a title is nice-to-have, never worth an error.
 */
export interface TitleResult {
  title: string | null;
  /** 上流が申告したコスト（USD）。載らなければ null。 */
  costUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  modelId: string;
}

export async function generateTitle(params: {
  userText: string;
  assistantText: string;
}): Promise<TitleResult> {
  const empty: TitleResult = {
    title: null,
    costUsd: null,
    promptTokens: null,
    completionTokens: null,
    modelId: TITLE_MODEL,
  };
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
        // タイトルも課金される。額を申告させて台帳に載せる
        // （小さいが、会話を作るたびに出ていく分なので見えないと困る）
        usage: { include: true },
      }),
    });
    if (!res.ok) return empty;
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        cost?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const used = {
      costUsd: num(body.usage?.cost),
      promptTokens: num(body.usage?.prompt_tokens),
      completionTokens: num(body.usage?.completion_tokens),
      modelId: TITLE_MODEL,
    };
    const raw = body.choices?.[0]?.message?.content?.trim();
    // 本文が取れなくても課金は起きているので、使用量は返す
    if (!raw) return { ...used, title: null };
    return {
      ...used,
      title: raw.replace(/^["「『]|["」』]$/g, "").slice(0, MAX_TITLE_LENGTH),
    };
  } catch {
    return empty;
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
 * sinceMs 以降に指定ボットで消費したポイントの合計。
 *
 * リトライ生成は1回の依頼で何度も生成するため、1件ずつ突き合わせても
 * 全体の消費が分からない。実行時間帯のエントリをまとめて合計する。
 */
export async function fetchPoeRunPoints(
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

    let points = 0;
    let costUsd = 0;
    let found = false;
    for (const e of entries) {
      const t = parsePoeTime(e.time);
      // 履歴は新しい順。実行開始より明確に古いところまで来たら打ち切る
      if (t != null && t < sinceMs - 60_000) break;
      if (String(e.bot_name ?? "").toLowerCase() !== botName.toLowerCase()) {
        continue;
      }
      const p = Number(e.cost_points);
      if (!Number.isFinite(p)) continue;
      points += p;
      const c = Number(e.cost_usd);
      if (Number.isFinite(c)) costUsd += c;
      found = true;
    }
    return found ? { points, costUsd: costUsd > 0 ? costUsd : undefined } : null;
  } catch {
    return null;
  }
}

/**
 * OpenRouterの chat/completions へのリクエスト。APIキーはサーバー側のみ。
 */
/** Poeの chat/completions（OpenAI互換）へのリクエスト。 */
/**
 * 上流が応答ヘッダを返すまでの猶予。
 *
 * これが無いと、接続だけ張って何も返さない上流に当たったとき、
 * 生成の実行（DOのアラーム）がそこで永久に止まる。
 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 60_000;

export async function poeChatRequest(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return await fetch(`${POE_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.POE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(UPSTREAM_CONNECT_TIMEOUT_MS),
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
    signal: signal ?? AbortSignal.timeout(UPSTREAM_CONNECT_TIMEOUT_MS),
  });
}
