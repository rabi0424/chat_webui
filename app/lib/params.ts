/**
 * 生成パラメータの定義。サーバー/クライアント共用。
 *
 * 方針（自動/手動方式）:
 * - 値が設定されていないパラメータ（= 自動）はAPIに一切送らない。
 *   送らなければ各プロバイダ/モデルの真の既定値が適用される
 *   （モデル別の公式既定値はAPIで取得できないため、これが唯一安全な扱い）。
 * - 手動に切り替えた項目だけ明示的な値を送る。
 * - モデル情報の対応パラメータ一覧と突き合わせ、
 *   モデルが対応するものだけをフォームに表示する。
 *
 * 窓口ごとに対応パラメータもリクエストの形式も異なるため、定義
 * （PARAM_DEFS / POE_* / APIYI_*）と組み立て（buildGenerationPayload）の
 * 両方を窓口で分ける。一方の設定値がもう一方へ漏れないよう、組み立て時に
 * 窓口側の許可リストで必ず絞る。パラメータは会話に付いたままモデルを
 * 乗り換えられるので、漏れは「たまたま前に使っていたモデルによって
 * 400 になる」という形で出る。
 */

import type { ModelInfo, PoeBotParameter } from "./openrouter.server";
import type { ImageSize } from "./image-size";
import {
  MAX_SCALE,
  MIN_SCALE,
  scaledOutputSize,
  type ResolvedSize,
} from "./output-size";

/** 手動設定された値の集合。キーがない = 自動（送らない）。 */
export type ParamsState = Record<string, number | string>;

interface BaseParamDef {
  key: string;
  label: string;
  description: string;
}

export interface NumberParamDef extends BaseParamDef {
  kind: "number";
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  /** 入力欄のプレースホルダに出す参考値（プラットフォーム一般既定値）。 */
  hint: string;
  /** 「自動」から手動に切り替えたときの初期値。 */
  defaultValue?: number;
}

export interface SelectParamDef extends BaseParamDef {
  kind: "select";
  options: { value: string; label: string }[];
  /** 「自動」から手動に切り替えたときの初期値。既定は末尾の選択肢。 */
  defaultValue?: string;
}

export interface TextParamDef extends BaseParamDef {
  kind: "text";
  placeholder: string;
}

/**
 * オン/オフだけの項目。
 *
 * 他の項目と違い「自動」が無い。上流に同じ設定があるわけではなく、
 * **こちらが計算して別の項目（size）へ変える**ものなので、「送らない」
 * ＝オフでしかない。三択に見せると、自動とオフの違いを説明できない。
 */
export interface ToggleParamDef extends BaseParamDef {
  kind: "toggle";
}

export type ParamDef =
  | NumberParamDef
  | SelectParamDef
  | TextParamDef
  | ToggleParamDef;

/** thinking（reasoning）設定。supported_parameters の "reasoning" に対応。 */
export const REASONING_KEY = "reasoning";

export const PARAM_DEFS: ParamDef[] = [
  {
    kind: "select",
    key: REASONING_KEY,
    label: "思考 (Thinking)",
    description: "回答前に推論させる。オンにすると思考トークン分の料金が加算される",
    options: [
      { value: "off", label: "オフ" },
      { value: "low", label: "低" },
      { value: "medium", label: "中" },
      { value: "high", label: "高" },
    ],
  },
  {
    kind: "number",
    key: "temperature",
    label: "Temperature",
    description: "回答のランダムさ。低いほど毎回同じような答えになる",
    min: 0,
    max: 2,
    step: 0.05,
    hint: "例: 1.0",
  },
  {
    kind: "number",
    key: "top_p",
    label: "Top P",
    description: "確率上位の候補だけから選ぶ割合",
    min: 0,
    max: 1,
    step: 0.01,
    hint: "例: 1.0",
  },
  {
    kind: "number",
    key: "max_tokens",
    label: "Max Tokens",
    description: "応答の最大トークン数",
    min: 1,
    max: 1024000,
    step: 1,
    integer: true,
    hint: "例: 4096",
  },
  {
    kind: "number",
    key: "top_k",
    label: "Top K",
    description: "確率上位K件の候補だけから選ぶ",
    min: 1,
    max: 1000,
    step: 1,
    integer: true,
    hint: "例: 40",
  },
  {
    kind: "number",
    key: "min_p",
    label: "Min P",
    description: "最有力候補に対する相対確率の足切り",
    min: 0,
    max: 1,
    step: 0.01,
    hint: "例: 0.05",
  },
  {
    kind: "number",
    key: "top_a",
    label: "Top A",
    description: "最有力候補の確率に応じた動的な足切り",
    min: 0,
    max: 1,
    step: 0.01,
    hint: "例: 0.1",
  },
  {
    kind: "number",
    key: "frequency_penalty",
    label: "Frequency Penalty",
    description: "同じ語の繰り返しを抑える度合い",
    min: -2,
    max: 2,
    step: 0.05,
    hint: "例: 0",
  },
  {
    kind: "number",
    key: "presence_penalty",
    label: "Presence Penalty",
    description: "既出の話題を避けて新しい話題を促す度合い",
    min: -2,
    max: 2,
    step: 0.05,
    hint: "例: 0",
  },
  {
    kind: "number",
    key: "repetition_penalty",
    label: "Repetition Penalty",
    description: "繰り返し全般へのペナルティ",
    min: 0,
    max: 2,
    step: 0.05,
    hint: "例: 1.0",
  },
  {
    kind: "number",
    key: "seed",
    label: "Seed",
    description: "乱数シード。同じ値なら（対応モデルでは）出力が再現されやすい",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    step: 1,
    integer: true,
    hint: "例: 42",
  },
  {
    kind: "select",
    key: "verbosity",
    label: "Verbosity",
    description: "応答の詳しさ（対応モデルのみ）",
    options: [
      { value: "low", label: "簡潔" },
      { value: "medium", label: "標準" },
      { value: "high", label: "詳細" },
    ],
  },
  {
    kind: "text",
    key: "stop",
    label: "Stop",
    description: "この文字列が出たら生成を停止（カンマ区切りで最大4つ）",
    placeholder: "例: END,###",
  },
];

/**
 * supported_parameters に載っていてもチャットUIとして意味がないため
 * 表示しないもの: tools / tool_choice / response_format /
 * structured_outputs / logit_bias / logprobs / top_logprobs /
 * web_search_options（⚙パネルのWeb検索トグルで代替） /
 * include_reasoning（非推奨） など。
 *
 * 注: ParamsState には定義済みキー以外の予約キーが入ることがある
 * （例: "web" = Web検索のオン/オフ。Chat.tsx 参照）。
 * buildGenerationPayload はプロバイダごとの許可リストしか読まないため、
 * これらがAPIリクエストへ漏れることはない。
 */

// --- Poe -------------------------------------------------------------------

/**
 * Poeのパラメータキー。OpenRouterとは名前も形式も異なる。
 *
 * 思考の強さは reasoning_effort（GPT系など）と thinking_budget（Claude系）。
 * OpenRouterの `reasoning: { effort }` 形式は解釈されない。対応可否は
 * Poeの /v1/models が返す reasoning から判定する（fetchPoeModels 参照）。
 */
export const POE_REASONING_EFFORT_KEY = "reasoning_effort";
export const POE_THINKING_BUDGET_KEY = "thinking_budget";

/**
 * ボット独自パラメータ。ParamsState 上ではこの接頭辞付きで持ち、
 * 送信時に接頭辞を外して extra_body へ入れる。
 *
 * 名前も選択肢もボットごとに違う（画像サイズが gpt-image-2 では `size`、
 * 他のボットでは `aspect_ratio`）。Poeは /v1/models の各モデルの
 * `parameters` でこれを公開しているので、そこから入力欄を組み立てる。
 * 知らない名前を送ると `Unknown parameter: '...'` で400になる
 * （Poeは extra_body の中身まで検証している）。
 * 公開していないボット向けには自由入力の欄も残す。
 */
export const POE_EXTRA_PREFIX = "poe_extra:";

/** ボット独自パラメータ名として受け付ける形。 */
export const POE_EXTRA_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/i;

/**
 * Poeがモデル共通で受け付ける標準パラメータ。
 *
 * Poeのプロトコル自体が temperature と stop_sequences を持つため、
 * OpenAI互換エンドポイントでもこの2つは通る。top_p・top_k・各種
 * ペナルティに相当するものはプロトコルに無いため出さない
 * （送っても黙って無視され、効かない設定がUIに並ぶだけになる）。
 */
const POE_STANDARD_KEYS = ["temperature", "stop"];

/** reasoning_effort の値はPoeがモデルごとに申告する。表示名だけこちらで持つ。 */
const EFFORT_LABELS: Record<string, string> = {
  none: "オフ",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
};

/** 思考トークン上限の初期値（範囲内に収める）。 */
function defaultBudget(budget: { min: number; max: number }): number {
  return Math.min(Math.max(2048, budget.min), budget.max);
}

/** Poeモデルの対応パラメータ名。fetchPoeModels から呼ぶ。 */
export function poeSupportedParameters(model: {
  efforts?: string[];
  reasoningBudget?: { min: number; max: number };
}): string[] {
  const keys = [...POE_STANDARD_KEYS];
  if (model.efforts && model.efforts.length > 0) {
    keys.push(POE_REASONING_EFFORT_KEY);
  }
  if (model.reasoningBudget) keys.push(POE_THINKING_BUDGET_KEY);
  return keys;
}

/** Poeモデル向けの定義。選択肢や範囲がモデル依存なので動的に組み立てる。 */
function poeParamDefs(model: ModelInfo): ParamDef[] {
  const supported = new Set(model.supportedParameters);
  const defs: ParamDef[] = [];

  const efforts = model.reasoningEfforts ?? [];
  if (supported.has(POE_REASONING_EFFORT_KEY) && efforts.length > 0) {
    defs.push({
      kind: "select",
      key: POE_REASONING_EFFORT_KEY,
      label: "思考 (Thinking)",
      description:
        "回答前に推論させる強さ。上げるほど思考トークン分の消費が増える",
      options: efforts.map((v) => ({ value: v, label: EFFORT_LABELS[v] ?? v })),
      defaultValue: efforts.includes("medium") ? "medium" : undefined,
    });
  }

  const budget = model.reasoningBudget;
  if (supported.has(POE_THINKING_BUDGET_KEY) && budget) {
    defs.push({
      kind: "number",
      key: POE_THINKING_BUDGET_KEY,
      label: "思考トークン上限",
      description: `思考に使えるトークン数（${budget.min}〜${budget.max}）`,
      min: budget.min,
      max: budget.max,
      step: 1,
      integer: true,
      hint: `例: ${defaultBudget(budget)}`,
      defaultValue: defaultBudget(budget),
    });
  }

  for (const def of PARAM_DEFS) {
    if (POE_STANDARD_KEYS.includes(def.key) && supported.has(def.key)) {
      defs.push(def);
    }
  }

  for (const p of model.botParameters ?? []) {
    defs.push(botParamDef(p));
  }
  return defs;
}

/** Poeが公開するボット固有パラメータを、入力欄の定義へ変換する。 */
function botParamDef(p: PoeBotParameter): ParamDef {
  const key = `${POE_EXTRA_PREFIX}${p.name}`;
  // 未指定なら既定値で動くので、何が起きるかを説明に添える
  const fallback =
    p.defaultValue != null ? `自動 = ${p.defaultValue}` : "このボット固有の設定";
  const description = p.description
    ? `${p.description}（${fallback}）`
    : fallback;

  if (p.options) {
    return {
      kind: "select",
      key,
      label: p.name,
      description,
      options: p.options.map((v) => ({ value: v, label: v })),
      defaultValue:
        typeof p.defaultValue === "string" &&
        p.options.includes(p.defaultValue)
          ? p.defaultValue
          : p.options[0],
    };
  }
  if (p.isBoolean) {
    return {
      kind: "select",
      key,
      label: p.name,
      description,
      options: [
        { value: "true", label: "オン" },
        { value: "false", label: "オフ" },
      ],
      defaultValue: p.defaultValue === true ? "true" : "false",
    };
  }
  if (p.min != null || p.max != null) {
    const min = p.min ?? 0;
    const max = p.max ?? Number.MAX_SAFE_INTEGER;
    return {
      kind: "number",
      key,
      label: p.name,
      description,
      min,
      max,
      step: p.integer ? 1 : 0.01,
      integer: p.integer,
      hint: p.defaultValue != null ? `例: ${p.defaultValue}` : `${min}〜${max}`,
      defaultValue: typeof p.defaultValue === "number" ? p.defaultValue : min,
    };
  }
  return {
    kind: "text",
    key,
    label: p.name,
    description,
    placeholder: p.defaultValue != null ? `例: ${p.defaultValue}` : "値",
  };
}

// --- 画像の大きさ（窓口共通の考え方） --------------------------------------

/**
 * 入力画像の解像度を一定倍して出力の大きさにする、の オン/オフ。
 *
 * 他の項目と違い、**上流にこの名前の設定は無い**。オンのときに
 * こちらで縦横を計算し、`size` として送る。流してしまうと「知らない
 * 項目」として 400 になり、その1本をまるごと失う——なので、この2つは
 * 上流へ送れる名前の一覧（`*_IMAGE_PARAM_KEYS`）には**入れない**。
 * 組み立てはその一覧しか見ないので、読み飛ばす処理も要らない。
 * ⚙に出す項目の一覧は別に持つ（`*_IMAGE_SETTING_KEYS`）。
 */
export const SIZE_FROM_INPUT_KEY = "size_from_input";
/** 入力画像に掛ける倍率（`SIZE_FROM_INPUT_KEY` がオンのときだけ効く）。 */
export const SIZE_SCALE_KEY = "size_scale";

/**
 * 選べる倍率。
 *
 * 細かく刻まないのは、出来上がりが上流の決まり（16の倍数・画素数の枠）へ
 * 丸められるため——1.1倍と1.2倍を選び分けても同じ大きさになることがある。
 */
export const SIZE_SCALE_CHOICES = [0.5, 1, 1.5, 2, 3, 4] as const;

/** 倍する設定がオンか。キーが無い＝オフ。 */
export function scalesFromInput(state: ParamsState | null | undefined): boolean {
  return state?.[SIZE_FROM_INPUT_KEY] === "on";
}

/** 倍率。範囲外・読めない値は既定（等倍）へ寄せる。 */
export function inputScaleOf(state: ParamsState | null | undefined): number {
  const raw = state?.[SIZE_SCALE_KEY];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.max(n, MIN_SCALE), MAX_SCALE);
}

/**
 * 倍した結果の大きさ。倍する設定がオフか、入力画像の大きさが読めなければ
 * null——そのときは⚙で選ばれている固定の `size` をそのまま使う。
 *
 * **⚙の見積もりも、実際に送る値もこの関数から出す。**別々に計算すると、
 * 画面は「2048×2048」と言っているのに違う大きさで作られる、という
 * 形で食い違う（絵は出るので、数えるまで気づけない）。
 */
export function resolveScaledSize(
  state: ParamsState | null | undefined,
  provider: "apiyi" | "runware",
  inputSize: ImageSize | null | undefined,
): ResolvedSize | null {
  if (!scalesFromInput(state) || !inputSize) return null;
  return scaledOutputSize(
    inputSize,
    inputScaleOf(state),
    provider === "runware"
      ? { provider: "runware" }
      : { provider: "apiyi", allowed: APIYI_ENUMS.size },
  );
}

/** 「入力画像に合わせる」の2項目（窓口で同じ文言にする）。 */
function inputScaleDefs(): ParamDef[] {
  return [
    {
      kind: "toggle",
      key: SIZE_FROM_INPUT_KEY,
      label: "入力画像に合わせる",
      description:
        "出力の縦横を、入力欄の画像の解像度を倍して決める（上のサイズは使わない）",
    },
    {
      // 段から選ばせる。自由入力にすると、打っている途中の値
      // （"1" → "13"）がそのまま倍率として効いてしまう
      kind: "select",
      key: SIZE_SCALE_KEY,
      label: "倍率",
      description: "入力画像の解像度に掛ける倍率",
      options: SIZE_SCALE_CHOICES.map((v) => ({
        value: String(v),
        label: `×${v}`,
      })),
      defaultValue: "1",
    },
  ];
}

// --- API易（画像） ---------------------------------------------------------

/**
 * API易の公式チャネルの画像モデルが受け付けるパラメータ。
 *
 * これは chat/completions のパラメータではない——このチャネルは
 * `/v1/images/generations` と `/v1/images/edits` しか受け付けず、
 * 名前も値も OpenAI の Images API のもの。上流が値の一覧を申告して
 * くれないので（中継の /v1/models はモデル名しか返さない）、**文書に
 * 書かれている値だけ**をここに置き、それ以外は送らない。知らない値を
 * 送ると 400 で弾かれ、1本まるごと失う。
 *
 * `auto` は選択肢に入れない。⚙の「自動」＝送らない＝上流の既定（auto）
 * なので、同じ意味の選び方が2つあると迷うだけになる。
 */
export const APIYI_IMAGE_PARAM_KEYS = [
  "size",
  "quality",
  "output_format",
  "output_compression",
  "background",
  "moderation",
] as const;

/**
 * ⚙に出す項目（上流へ送れる名前＋こちらで計算に使う項目）。
 *
 * モデルの申告（`supportedParameters`）はこちらを使う。送信の側は
 * 上の一覧しか見ないので、ここへ足しても上流へは流れない。
 */
export const APIYI_IMAGE_SETTING_KEYS: readonly string[] = [
  ...APIYI_IMAGE_PARAM_KEYS,
  SIZE_FROM_INPUT_KEY,
  SIZE_SCALE_KEY,
];

/** 値の一覧（文書に載っているものだけ）。 */
const APIYI_ENUMS: Record<string, string[]> = {
  size: [
    "1024x1024",
    "1536x1024",
    "1024x1536",
    "2048x2048",
    "2048x1152",
    "3840x2160",
    "2160x3840",
  ],
  // xhigh と max は 2.5 で増えた段。上の段ほど遅く、高い
  quality: ["low", "medium", "high", "xhigh", "max"],
  output_format: ["png", "jpeg", "webp"],
  // transparent は 400 になるので出さない
  background: ["opaque"],
  moderation: ["low"],
};

const APIYI_IMAGE_PARAM_DEFS: ParamDef[] = [
  {
    kind: "select",
    key: "size",
    label: "サイズ",
    description: "出力の縦横（自動なら上流が依頼文から決める）",
    options: APIYI_ENUMS.size.map((v) => ({ value: v, label: v })),
    defaultValue: "1024x1024",
  },
  ...inputScaleDefs(),
  {
    kind: "select",
    key: "quality",
    label: "品質",
    description:
      "上げるほど時間も額も増える（max と 4K の組み合わせは数分かかる）",
    options: APIYI_ENUMS.quality.map((v) => ({ value: v, label: v })),
    defaultValue: "high",
  },
  {
    kind: "select",
    key: "output_format",
    label: "形式",
    description: "画像の形式",
    options: APIYI_ENUMS.output_format.map((v) => ({ value: v, label: v })),
    defaultValue: "png",
  },
  {
    kind: "number",
    key: "output_compression",
    label: "圧縮率",
    description: "jpeg・webp のときだけ効く（0〜100）",
    min: 0,
    max: 100,
    step: 1,
    integer: true,
    hint: "例: 85",
    defaultValue: 85,
  },
  {
    kind: "select",
    key: "background",
    label: "背景",
    description: "opaque は透過を作らせない（transparent は上流が弾く）",
    options: [{ value: "opaque", label: "不透過 (opaque)" }],
    defaultValue: "opaque",
  },
  {
    kind: "select",
    key: "moderation",
    label: "審査の強さ",
    description: "low は上流の判定を緩める",
    options: [{ value: "low", label: "低 (low)" }],
    defaultValue: "low",
  },
];

/**
 * API易向けのリクエストボディ。
 *
 * 送るのは上の一覧にある名前と値だけ。会話には他の窓口向けの設定値が
 * 残っているので（モデルを乗り換えてもパラメータは会話に付いたまま）、
 * ここを素通しにすると知らないフィールドとして 400 になる。
 */
function buildApiyiPayload(
  state: ParamsState,
  inputSize: ImageSize | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const scaled = resolveScaledSize(state, "apiyi", inputSize);
  for (const key of APIYI_IMAGE_PARAM_KEYS) {
    // 倍して決まった大きさは⚙の選択肢に無いが、選べる値の中から
    // 選び直したもの（nearestAllowedSize）なので、そのまま送る
    if (key === "size" && scaled) {
      out.size = scaled.value;
      continue;
    }
    const raw = state[key];
    if (raw == null) continue;
    if (key === "output_compression") {
      const n = toNumber(raw);
      if (n === undefined) continue;
      out[key] = Math.min(Math.max(Math.round(n), 0), 100);
      continue;
    }
    // 選択肢に無い値は捨てる（保存済みの古い設定や手書きの値が混ざる）
    if (typeof raw === "string" && APIYI_ENUMS[key]?.includes(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

// --- Runware（画像） -------------------------------------------------------

/**
 * Runware の画像モデルに出すパラメータ。
 *
 * 名前は API易 の画像モデルと**わざと揃えてある**（`size`・`quality`・
 * `moderation`…）。パラメータは会話に付いたままモデルを乗り換えられる
 * ので、同じ意味の設定に別の名前を使うと、窓口を変えたとたんに黙って
 * 「自動」へ戻る。値の検査は窓口ごとに行うので、揃えても混ざらない。
 *
 * ただし**送る形は上流ごとに全く違う**。Runware は `size` という項目を
 * 持たず `width`/`height` を必須で取り、審査や品質は入れ子の中へ置く。
 * その組み立ては runware.server.ts が行い、ここでは「⚙で選ばれた値を
 * 検査して平らに並べる」までにする。
 */
export const RUNWARE_IMAGE_PARAM_KEYS = [
  "size",
  "quality",
  "moderation",
  "background",
  "output_format",
  "output_compression",
] as const;

/** ⚙に出す項目（API易 と同じ考え方。上の注記）。 */
export const RUNWARE_IMAGE_SETTING_KEYS: readonly string[] = [
  ...RUNWARE_IMAGE_PARAM_KEYS,
  SIZE_FROM_INPUT_KEY,
  SIZE_SCALE_KEY,
];

/**
 * 上流の文書にある値だけ。
 *
 * `auto` は選択肢に入れない（⚙の「自動」＝送らない＝上流の既定が
 * `auto`。同じ意味の選び方が2つあると迷うだけになる）。
 */
const RUNWARE_ENUMS: Record<string, string[]> = {
  // 上流が勧める組み合わせ。縦横は16の倍数・総画素数 655,360〜8,294,400・
  // 縦横比 3:1 までという制約があり、外れると 400 になる
  size: ["1024x1024", "1536x1024", "1024x1536", "2560x1440", "3840x2160"],
  quality: ["low", "medium", "high", "xhigh", "max"],
  moderation: ["low"],
  background: ["opaque", "transparent"],
  output_format: ["PNG", "JPG", "WEBP"],
};

/**
 * 品質の段はモデルごとに違う（`xhigh` と `max` は新しい世代で増えた）。
 *
 * 受け付けない段を送ると 400 になり、その1本をまるごと失う。どの段を
 * 受けるかはモデルの表（runware.server.ts）にあり、一覧に載って
 * 渡ってくるので、選択肢はそれに従う。
 */
function runwareImageParamDefs(quality: string[]): ParamDef[] {
  return [
    {
      kind: "select",
      key: "size",
      label: "サイズ",
      description:
        "出力の縦横。上流が必須にしているので、自動のままでも 1024x1024 で送る",
      options: RUNWARE_ENUMS.size.map((v) => ({ value: v, label: v })),
      defaultValue: "1024x1024",
    },
    ...inputScaleDefs(),
    {
      kind: "select",
      key: "quality",
      label: "品質",
      description: "上げるほど時間も額も増える（額は出来上がりに応じた従量）",
      options: quality.map((v) => ({ value: v, label: v })),
      defaultValue: "high",
    },
    {
      kind: "select",
      key: "moderation",
      label: "審査の強さ",
      description: "low は上流の判定を緩める（自動 = auto は標準の判定）",
      options: [{ value: "low", label: "低 (low)" }],
      defaultValue: "low",
    },
    {
      kind: "select",
      key: "background",
      label: "背景",
      description:
        "transparent は透過。形式が JPG のままだと上流が弾くので PNG に寄せる",
      options: [
        { value: "opaque", label: "不透過 (opaque)" },
        { value: "transparent", label: "透過 (transparent)" },
      ],
      defaultValue: "opaque",
    },
    {
      kind: "select",
      key: "output_format",
      label: "形式",
      description: "画像の形式（自動は上流の既定 = JPG）",
      options: RUNWARE_ENUMS.output_format.map((v) => ({ value: v, label: v })),
      defaultValue: "PNG",
    },
    {
      kind: "number",
      key: "output_compression",
      label: "圧縮率",
      description: "jpeg・webp のときだけ効く（20〜99）",
      min: 20,
      max: 99,
      step: 1,
      integer: true,
      hint: "例: 95",
      defaultValue: 95,
    },
  ];
}

/**
 * Runware 向けの、検査済みの平らな設定値。
 *
 * ここでは入れ子にしない。審査と品質の置き場がモデルの世代で変わる
 * （`settings` か `providerSettings.<creator>` か）ため、置き場を知って
 * いる runware.server.ts で組み立てる。
 */
function buildRunwarePayload(
  state: ParamsState,
  inputSize: ImageSize | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const scaled = resolveScaledSize(state, "runware", inputSize);
  for (const key of RUNWARE_IMAGE_PARAM_KEYS) {
    // 倍して決まった大きさは⚙の選択肢には無い。上流の決まり（16の倍数・
    // 総画素数・縦横比）へ収めた値なので、選択肢の検査は通さない
    if (key === "size" && scaled) {
      out.size = scaled.value;
      continue;
    }
    const raw = state[key];
    if (raw == null) continue;
    if (key === "output_compression") {
      const n = toNumber(raw);
      if (n === undefined) continue;
      out[key] = Math.min(Math.max(Math.round(n), 20), 99);
      continue;
    }
    // 選択肢に無い値は捨てる（別の窓口向けの設定値や、古い保存が混ざる）。
    // 品質の段は世代で違うが、ここでは広いほうで通す——狭めるのは
    // 選択肢の側（画面）と、モデルの素性を知っている組み立ての側の役目
    if (typeof raw === "string" && RUNWARE_ENUMS[key]?.includes(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

// --- 共通 ------------------------------------------------------------------

/** モデルが対応するパラメータ定義だけを返す。 */
export function paramsForModel(model: ModelInfo | undefined): ParamDef[] {
  if (!model) return [];
  if (model.provider === "poe") return poeParamDefs(model);
  const supported = new Set(model.supportedParameters);
  if (model.provider === "apiyi") {
    return APIYI_IMAGE_PARAM_DEFS.filter((p) => supported.has(p.key));
  }
  if (model.provider === "runware") {
    return runwareImageParamDefs(
      model.runwareQuality ?? RUNWARE_ENUMS.quality,
    ).filter((p) => supported.has(p.key));
  }
  return PARAM_DEFS.filter((p) => supported.has(p.key));
}

/**
 * 手動設定値をリクエストボディへ変換する。
 *
 * パラメータは会話（およびボット）単位で保存され、モデルとは紐付かない。
 * モデルを乗り換えると別プロバイダ向けの設定値が残っているため、
 * ここでプロバイダ側の許可リストを必ず通す（サーバー側の検証も兼ねる）。
 * 不正値・未対応キーは黙って捨てる。
 */
export function buildGenerationPayload(
  state: ParamsState | null | undefined,
  provider: ModelInfo["provider"] = "openrouter",
  /**
   * 入力画像（＝直近のユーザーメッセージの添付の1枚目）の縦横。
   * 「入力画像に合わせる」がオンのときだけ読む。渡さなければ、その設定は
   * 効かず、⚙で選ばれている固定のサイズがそのまま送られる。
   */
  inputSize: ImageSize | null | undefined = null,
): Record<string, unknown> {
  if (!state || typeof state !== "object") return {};
  if (provider === "poe") return buildPoePayload(state);
  if (provider === "apiyi") return buildApiyiPayload(state, inputSize);
  if (provider === "runware") return buildRunwarePayload(state, inputSize);
  return buildOpenRouterPayload(state);
}

/**
 * 数値として送ってよい値か判定する。送れないなら undefined。
 *
 * Number("") は 0 になる。空欄は「未設定（モデルの既定に任せる）」の
 * つもりなので、0 として送ってしまうと temperature 0（毎回同じ答え）の
 * ように挙動が黙って変わる。UIはキーごと消すが、APIは params を
 * 無検証で受け取るため、ここでも空欄を弾く。
 */
function toNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** カンマ区切りの停止文字列をAPIの配列形式へ。 */
function parseStops(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

/**
 * Poe向けのリクエストボディ。
 *
 * Poe独自パラメータ（thinking_budget やボット固有のもの）は extra_body に
 * 入れて送る。ボディ直下へ置くと未知フィールドとして400が返る。
 * OpenAI SDKの extra_body はボディ直下へ展開される仕組みだが、
 * Poeのサーバーは extra_body というキー自体を読んでボットへ渡す。
 * ただし中身も検証しており、そのボットが知らない名前は
 * `Unknown parameter: '...'` で弾かれる。
 *
 * reasoning_effort は独自拡張ではなくOpenAI標準のフィールドなので、
 * これはボディ直下へ置く（モデルが対応を申告したときだけ出す）。
 */
function buildPoePayload(state: ParamsState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};

  const temperature = toNumber(state.temperature);
  if (temperature !== undefined) {
    out.temperature = Math.min(Math.max(temperature, 0), 2);
  }

  const stops = parseStops(state.stop);
  if (stops.length > 0) out.stop = stops;

  const effort = state[POE_REASONING_EFFORT_KEY];
  if (typeof effort === "string" && /^[a-z]+$/.test(effort)) {
    out[POE_REASONING_EFFORT_KEY] = effort;
  }

  // ボット独自パラメータ。値はボットへそのまま渡るため、型だけ整える
  for (const [key, raw] of Object.entries(state)) {
    if (!key.startsWith(POE_EXTRA_PREFIX)) continue;
    const name = key.slice(POE_EXTRA_PREFIX.length);
    if (!POE_EXTRA_KEY_PATTERN.test(name)) continue;
    const parsed = parseExtraValue(raw);
    if (parsed !== undefined) custom[name] = parsed;
  }

  // 型付きの項目は独自パラメータより優先する（同名になっても壊さない）
  const budget = toNumber(state[POE_THINKING_BUDGET_KEY]);
  if (budget !== undefined && budget > 0) {
    custom[POE_THINKING_BUDGET_KEY] = Math.round(budget);
  }

  if (Object.keys(custom).length > 0) out.extra_body = custom;
  return out;
}

/**
 * ボット独自パラメータの値。UIでは文字列で持つが、Poeのボットは
 * 真偽値・数値も取る（web_search: true, thinking_budget: 1000 など）ため、
 * 見たままの型へ寄せて送る。
 */
function parseExtraValue(raw: unknown): string | number | boolean | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (v === "") return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  // "16:9" のような値を数値扱いしないよう、全体が数値のときだけ変換する
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** OpenRouter向けのリクエストボディ。 */
function buildOpenRouterPayload(state: ParamsState): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const def of PARAM_DEFS) {
    const raw = state[def.key];
    if (raw == null) continue;

    if (def.key === REASONING_KEY) {
      if (raw === "off") out.reasoning = { enabled: false };
      else if (raw === "low" || raw === "medium" || raw === "high") {
        out.reasoning = { effort: raw };
      }
      continue;
    }

    if (def.kind === "number") {
      const value = toNumber(raw);
      if (value === undefined) continue;
      // 範囲に収めてから送る。保存済みの設定に範囲外の値が残っていると
      // （UIの制限が変わった後など）上流が400で弾き、生成そのものが
      // 英語のエラーで失敗する。Poe側は既にクランプしていて非対称だった
      const clamped = Math.min(Math.max(value, def.min), def.max);
      out[def.key] = def.integer ? Math.round(clamped) : clamped;
    } else if (def.kind === "select") {
      if (
        typeof raw === "string" &&
        def.options.some((o) => o.value === raw)
      ) {
        out[def.key] = raw;
      }
    } else if (def.kind === "text" && def.key === "stop") {
      const stops = parseStops(raw);
      if (stops.length > 0) out.stop = stops;
    }
  }
  return out;
}

/** JSON文字列から ParamsState を安全に復元する。 */
export function parseParamsJson(json: string | null | undefined): ParamsState {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ParamsState;
    }
  } catch {
    // 壊れたJSONは空扱い
  }
  return {};
}
