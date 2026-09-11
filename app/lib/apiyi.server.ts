/**
 * API易（apiyi）— 3つ目の窓口。
 *
 * OpenAI互換の中継で、1本の鍵から各社のモデルを呼べる。このアプリが
 * 使うのは画像生成の数本だけなので、**一覧は丸ごと取らない**。
 *
 * 載せるモデルは環境変数 `APIYI_MODELS` で指定する。決め打ちにしない
 * 理由は2つ:
 *   - 上流のモデル名は予告なく増減する。名前をコードに埋めると、
 *     入れ替えのたびにデプロイが要る。
 *   - モデル名をリポジトリへ置かない（このリポジトリの決まりごと）。
 *
 * モデルの素性（価格・画像を出すか）は、**認証の要らない価格表**
 * （/api/pricing）から取る。上流の /v1/models はモデル名しか返さず、
 * コンテキスト長も価格も載っていない。
 */
import { env } from "cloudflare:workers";
import { APIYI_PREFIX, bareModelName, isApiyiModel } from "./constants";
import { APIYI_IMAGE_PARAM_KEYS } from "./params";
import type { ModelInfo } from "./openrouter.server";
import {
  UPSTREAM_CONNECT_TIMEOUT_MS,
  fetchAwaitingHeaders,
} from "./upstream-fetch.server";

/** OpenAI互換のエンドポイント。Claude系・Gemini系もここから呼べる。 */
const APIYI_BASE = "https://api.apiyi.com/v1";

/**
 * 画像モデルは chat/completions では呼べない。
 *
 * 公式チャネル（素の名前）が受け付けるのは Images API の2本だけで、
 * 上流の文書は chat 形式を「非対応」と明記している（chat で呼べるのは
 * 逆向チャネルの副経路だけ）。価格表の `openai` という項目はこれと
 * 食い違うが、こちらは中継全体の分類でしかない。
 *
 * 添付が無ければ生成、あれば編集。編集は multipart で、画像の並び順が
 * 依頼文の中の「図1／図2」に対応する。
 */
const APIYI_IMAGE_GENERATIONS = `${APIYI_BASE}/images/generations`;
const APIYI_IMAGE_EDITS = `${APIYI_BASE}/images/edits`;

/** 編集に渡せる画像の上限（上流の制限）。 */
const MAX_EDIT_IMAGES = 16;

/** 価格表。鍵が要らないので、キー未設定でも取れる。 */
const APIYI_PRICING_URL = "https://api.apiyi.com/api/pricing";

/**
 * 価格表の「倍率」1あたりのトークン単価（USD）。
 *
 * この中継の価格表は額ではなく倍率で出る（`model_ratio` と
 * `completion_ratio`）。もとは OpenAI の旧価格 $0.002/1K トークンが
 * 倍率1で、入力単価 = model_ratio × $0.002/1K、出力単価 = 入力 ×
 * completion_ratio。この式は上流が別に公開しているモデル一覧
 * （docs 側の model-registry.json）の実額と突き合わせて確かめてある
 * （倍率2.5・完了倍率6 → $5/M・$30/M）。
 */
const USD_PER_TOKEN_PER_RATIO = 0.002 / 1000;

/** 価格表の1行（読む項目だけ）。 */
interface PricingRow {
  model_name?: unknown;
  vendor_name?: unknown;
  /** 0 = トークン従量、1 = 1回いくら。 */
  quota_type?: unknown;
  model_ratio?: unknown;
  completion_ratio?: unknown;
  /** quota_type === 1 のときの1回あたりの額（USD）。 */
  model_price?: unknown;
  supported_endpoint_types?: unknown;
}

/** モデル1本の価格。台帳へ載せる額はここから出す。 */
export interface ApiyiPrice {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  /** 1回いくらのモデルだけ。トークン数によらずこの額。 */
  perCallUsd?: number;
}

interface ApiyiModelSpec extends ApiyiPrice {
  vendor: string;
  /** 画像を返すモデルか（価格表のエンドポイント種別から判定）。 */
  imageOutput: boolean;
}

/**
 * 数値として読めれば返す。読めなければ undefined。
 * 価格表は文字列で数字を返すことがある。
 */
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 価格表の1行を、このアプリが使う形へ。読めない行は undefined。 */
export function parseApiyiPricingRow(row: PricingRow): ApiyiModelSpec | undefined {
  const name = typeof row.model_name === "string" ? row.model_name : "";
  if (!name) return undefined;

  const endpoints = Array.isArray(row.supported_endpoint_types)
    ? row.supported_endpoint_types.filter((x): x is string => typeof x === "string")
    : [];
  // 画像を出すモデルは、応答が返るまで長く黙る。ここを取り違えると
  // ヘッダ待ちの猶予が60秒のままになり、上流では生成が終わって課金
  // されているのにこちらには何も残らない（generation.server.ts）
  const imageOutput = endpoints.includes("image-generation");

  const ratio = num(row.model_ratio) ?? 0;
  const completionRatio = num(row.completion_ratio) ?? 1;
  const inputUsdPerToken = ratio > 0 ? ratio * USD_PER_TOKEN_PER_RATIO : 0;
  const perCall = num(row.model_price) ?? 0;

  return {
    vendor: typeof row.vendor_name === "string" ? row.vendor_name : "",
    imageOutput,
    inputUsdPerToken,
    outputUsdPerToken: inputUsdPerToken * (completionRatio > 0 ? completionRatio : 1),
    // 1回いくらは quota_type が 1 のときだけ。0（従量）の行にも
    // model_price が 0 以外で入っていることがあり、そのまま読むと
    // トークン課金のモデルに1回ぶんの額を上乗せしてしまう
    perCallUsd: num(row.quota_type) === 1 && perCall > 0 ? perCall : undefined,
  };
}

interface PricingCache {
  specs: Map<string, ApiyiModelSpec>;
  fetchedAt: number;
}

const PRICING_TTL_MS = 60 * 60 * 1000;

/**
 * 価格表の持ち回り。モジュール変数なので実行体（isolate）ごとに1回。
 *
 * 生成の実行は Durable Object の中で走り、そこではモデル一覧を取って
 * いない。額を出すためだけに毎回取りに行くとサブリクエストの枠を
 * 削るので、取ったものは同じ実行体の中で使い回す。
 */
let pricingCache: PricingCache | null = null;

/** テスト用。実行体をまたいで持ち回る値を捨てる。 */
export function resetApiyiPricingCache(): void {
  pricingCache = null;
}

/** 価格表を取る。失敗したら空（額が出せないだけで、生成はできる）。 */
export async function fetchApiyiPricing(
  /** 外部へ1件投げることを呼ぶ側へ知らせる（枠の数え上げ）。 */
  onRequest: () => void = () => {},
): Promise<Map<string, ApiyiModelSpec>> {
  if (pricingCache && Date.now() - pricingCache.fetchedAt < PRICING_TTL_MS) {
    return pricingCache.specs;
  }
  try {
    onRequest();
    const res = await fetch(APIYI_PRICING_URL);
    if (!res.ok) return pricingCache?.specs ?? new Map();
    const body = (await res.json()) as { data?: PricingRow[] };
    const specs = new Map<string, ApiyiModelSpec>();
    for (const row of body.data ?? []) {
      const spec = parseApiyiPricingRow(row);
      if (spec) specs.set(String(row.model_name), spec);
    }
    // 空の応答で上書きしない。取れていた表を捨てると額が出なくなる
    if (specs.size === 0) return pricingCache?.specs ?? specs;
    pricingCache = { specs, fetchedAt: Date.now() };
    return specs;
  } catch {
    return pricingCache?.specs ?? new Map();
  }
}

/**
 * `APIYI_MODELS` に並んだモデル名。
 *
 * カンマ・空白・改行のどれで区切ってもよい（設定画面ではなく環境変数に
 * 手で書く値なので、区切りを間違えて全部が1つの名前になると
 * 「一覧に出ない」という形でしか分からない）。
 */
export function parseApiyiModelNames(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const name = part.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

/** 価格表の1本を、一覧に出す形へ。 */
export function buildApiyiModelInfo(
  name: string,
  spec: ApiyiModelSpec | undefined,
): ModelInfo {
  const vendor = spec?.vendor ? `${spec.vendor} · ` : "";
  const billing = spec
    ? spec.perCallUsd != null
      ? `1回 $${spec.perCallUsd}`
      : "トークン従量"
    : "価格の申告が見つかりません";
  return {
    id: `${APIYI_PREFIX}${name}`,
    name,
    description: `API易（${vendor}${billing}）`,
    // 中継はコンテキスト長を申告しない。0 は画面側で「出さない」印
    contextLength: 0,
    promptPrice: String(spec?.inputUsdPerToken ?? 0),
    completionPrice: String(spec?.outputUsdPerToken ?? 0),
    // 画像を出すモデルは画像も受け取れる（手元の画像を渡して直させる）。
    // 文章のモデルが画像を読めるかはここからは分からないので、
    // 画像を出すモデルにだけ「画像」を付ける
    inputModalities: spec?.imageOutput ? ["text", "image"] : ["text"],
    outputModalities: spec?.imageOutput ? ["text", "image"] : ["text"],
    /*
     * 中継は対応パラメータを申告しない（/v1/models はモデル名だけ）。
     * 画像モデルが受け付ける名前と値は上流の文書に載っているので、
     * それだけを出す（params.ts）。文章のモデルは申告が無いため空に
     * する——推測で並べると「効くように見えて効かない」入力欄になり、
     * 知らない名前を送れば 400 で1本まるごと失う。
     */
    supportedParameters: spec?.imageOutput ? [...APIYI_IMAGE_PARAM_KEYS] : [],
    provider: "apiyi",
    perCallUsd: spec?.perCallUsd,
    createdAt: 0,
  };
}

/**
 * API易のモデル一覧。キーか対象の指定が無ければ空（任意の機能）。
 *
 * 一覧そのものは上流から取らない（名前しか返らないうえ300本以上ある）。
 * 指定された名前を価格表と突き合わせて組み立てる。
 */
export async function fetchApiyiModels(): Promise<ModelInfo[]> {
  if (!env.APIYI_API_KEY) return [];
  const names = parseApiyiModelNames(env.APIYI_MODELS);
  if (names.length === 0) return [];
  const specs = await fetchApiyiPricing();
  return names.map((name) => buildApiyiModelInfo(name, specs.get(name)));
}

/** 編集のときに渡す入力画像。 */
export interface ApiyiInputImage {
  data: ArrayBuffer;
  mimeType: string;
}

/** multipart に載せる名前（拡張子が無いと上流が形式を判別できない）。 */
function fileNameFor(mimeType: string, index: number): string {
  const ext = mimeType.split("/")[1]?.split("+")[0] ?? "png";
  return `image${index + 1}.${ext === "jpeg" ? "jpg" : ext}`;
}

/**
 * Images API へのリクエスト。添付があれば編集、無ければ生成。
 *
 * `stream` は付けない。このチャネルの画像生成は同期呼び出しで、
 * 途中経過を流すには `partial_images` が要り、そのぶん追加の
 * トークンが課金される。1枚を確実に受け取るほうを採る。
 */
export interface ApiyiImageRequest {
  model: string;
  prompt: string;
  images: ApiyiInputImage[];
  /** ⚙で手動にしたパラメータ（size・quality など）。 */
  params: Record<string, unknown>;
}

/**
 * 投げ先と本文を組み立てる（鍵には触らない）。
 *
 * 鍵を足すところと分けてあるのは、ここだけをテストから通せるように
 * するため。multipart の組み立ては目で見ても正しさが分からない
 * （名前を1つ間違えても 400 が返るだけ）。
 */
export function apiyiImageRequestInit(req: ApiyiImageRequest): {
  url: string;
  body: BodyInit;
  /** JSON として送るか（multipart なら false）。 */
  json: boolean;
} {
  if (req.images.length === 0) {
    return {
      url: APIYI_IMAGE_GENERATIONS,
      json: true,
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        ...req.params,
      }),
    };
  }

  const form = new FormData();
  form.set("model", req.model);
  form.set("prompt", req.prompt);
  for (const [key, value] of Object.entries(req.params)) {
    form.set(key, String(value));
  }
  // 並び順が依頼文の「図1／図2」に対応するので、順番を崩さない
  req.images.slice(0, MAX_EDIT_IMAGES).forEach((img, i) => {
    form.append(
      "image",
      new Blob([img.data], { type: img.mimeType }),
      fileNameFor(img.mimeType, i),
    );
  });
  return { url: APIYI_IMAGE_EDITS, json: false, body: form };
}

export async function apiyiImageRequest(
  req: ApiyiImageRequest,
  connectTimeoutMs: number = UPSTREAM_CONNECT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Response> {
  const init = apiyiImageRequestInit(req);
  return await fetchAwaitingHeaders(
    init.url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.APIYI_API_KEY}`,
        // multipart のときは付けない（境界文字列は fetch が決める。
        // 手で付けると本文と食い違って上流がパースに失敗する）
        ...(init.json ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body,
    },
    connectTimeoutMs,
    signal,
  );
}

/**
 * API易の chat/completions（OpenAI互換）へのリクエスト。
 *
 * 画像モデルはこの経路では呼べない（上の注記）。文章のモデルを
 * `APIYI_MODELS` に足したときのための経路。
 */
export async function apiyiChatRequest(
  body: Record<string, unknown>,
  connectTimeoutMs: number = UPSTREAM_CONNECT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Response> {
  return await fetchAwaitingHeaders(
    `${APIYI_BASE}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.APIYI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    connectTimeoutMs,
    signal,
  );
}

/** 使用量（トークン数）から額を出す。出せなければ null。 */
export function estimateApiyiCost(
  price: ApiyiPrice | undefined,
  usage: { promptTokens?: number | null; completionTokens?: number | null },
): number | null {
  if (!price) return null;
  // 1回いくらのモデルは、トークン数を見ずにこの額。応答が空でも
  // 上流は1回ぶん取る
  if (price.perCallUsd != null) return price.perCallUsd;
  if (price.inputUsdPerToken <= 0 && price.outputUsdPerToken <= 0) return null;
  const prompt = Number(usage.promptTokens);
  const completion = Number(usage.completionTokens);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return (
    (Number.isFinite(prompt) ? prompt : 0) * price.inputUsdPerToken +
    (Number.isFinite(completion) ? completion : 0) * price.outputUsdPerToken
  );
}

/**
 * 応答の使用量に額を足す。API易以外のモデルでは何もしない。
 *
 * この中継は OpenAI 互換なのでトークン数は返すが、**額は返さない**
 * （OpenRouter の `usage.cost` に当たるものが無い）。足さないと、
 * 台帳への記録が `cost も points も無い` として丸ごと捨てられ、
 * 月間上限にも使用量の画面にも一切出てこない。
 *
 * 額は価格表からの見積もりで、上流の請求そのものではない
 * （利用者の group による割引はこの表からは分からない）。
 */
export async function applyApiyiCost(
  modelId: string,
  usageJson: string | null,
  onRequest: () => void = () => {},
): Promise<string | null> {
  if (!isApiyiModel(modelId)) return usageJson;
  let usage: Record<string, unknown> = {};
  if (usageJson) {
    try {
      usage = JSON.parse(usageJson) as Record<string, unknown>;
    } catch {
      usage = {};
    }
  }
  // 既に額が入っているなら触らない（上流が載せてきた場合）
  if (Number.isFinite(Number(usage.cost)) && Number(usage.cost) > 0) {
    return usageJson;
  }
  const specs = await fetchApiyiPricing(onRequest);
  const cost = estimateApiyiCost(specs.get(bareModelName(modelId)), {
    promptTokens: num(usage.promptTokens) ?? null,
    completionTokens: num(usage.completionTokens) ?? null,
  });
  if (cost == null) return usageJson;
  return JSON.stringify({ ...usage, cost });
}
