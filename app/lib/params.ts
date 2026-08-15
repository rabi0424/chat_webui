/**
 * 生成パラメータの定義。サーバー/クライアント共用。
 *
 * 方針（自動/手動方式）:
 * - 値が設定されていないパラメータ（= 自動）はAPIに一切送らない。
 *   送らなければ各プロバイダ/モデルの真の既定値が適用される
 *   （モデル別の公式既定値はAPIで取得できないため、これが唯一安全な扱い）。
 * - 手動に切り替えた項目だけ明示的な値を送る。
 * - OpenRouterのモデル情報 supported_parameters と突き合わせ、
 *   モデルが対応するものだけをフォームに表示する。
 */

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
}

export interface SelectParamDef extends BaseParamDef {
  kind: "select";
  options: { value: string; label: string }[];
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
 * 注: ParamsState には PARAM_DEFS 以外の予約キーが入ることがある
 * （例: "web" = Web検索のオン/オフ。Chat.tsx 参照）。
 * buildGenerationPayload は PARAM_DEFS のキーしか読まないため、
 * これらがAPIリクエストへ漏れることはない。
 */

/** モデルが対応するパラメータ定義だけを返す。 */
export function paramsForModel(supportedParameters: string[]): ParamDef[] {
  const supported = new Set(supportedParameters);
  return PARAM_DEFS.filter((p) => supported.has(p.key));
}

/**
 * 手動設定値をOpenRouterのリクエストボディ用に変換する。
 * 不正値・未対応キーは黙って捨てる（サーバー側の許可リストを兼ねる）。
 */
export function buildGenerationPayload(
  state: ParamsState | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!state || typeof state !== "object") return out;

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
      if (typeof raw === "string") {
        const stops = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 4);
        if (stops.length > 0) out.stop = stops;
      }
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
