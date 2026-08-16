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
 * OpenRouterとPoeでは対応パラメータもリクエストの形式も異なるため、
 * 定義（PARAM_DEFS / POE_*）と組み立て（buildGenerationPayload）の
 * 両方をプロバイダで分ける。一方の設定値がもう一方へ漏れないよう、
 * 組み立て時にプロバイダ側の許可リストで必ず絞る。
 */

import type { ModelInfo, PoeBotParameter } from "./openrouter.server";

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

export type ParamDef = NumberParamDef | SelectParamDef | TextParamDef;

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

// --- 共通 ------------------------------------------------------------------

/** モデルが対応するパラメータ定義だけを返す。 */
export function paramsForModel(model: ModelInfo | undefined): ParamDef[] {
  if (!model) return [];
  if (model.provider === "poe") return poeParamDefs(model);
  const supported = new Set(model.supportedParameters);
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
): Record<string, unknown> {
  if (!state || typeof state !== "object") return {};
  return provider === "poe"
    ? buildPoePayload(state)
    : buildOpenRouterPayload(state);
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

  const temperature = Number(state.temperature);
  if (state.temperature != null && Number.isFinite(temperature)) {
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
  const budget = Number(state[POE_THINKING_BUDGET_KEY]);
  if (Number.isFinite(budget) && budget > 0) {
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
      const value = typeof raw === "number" ? raw : Number(raw);
      if (Number.isNaN(value)) continue;
      out[def.key] = def.integer ? Math.round(value) : value;
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
