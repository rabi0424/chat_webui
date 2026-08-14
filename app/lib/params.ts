/**
 * ボットに設定できる生成パラメータの定義。サーバー/クライアント共用。
 * OpenRouterのモデル情報 supported_parameters と突き合わせ、
 * モデルが対応するものだけをフォームに表示する。
 */

export interface ParamDef {
  key: string;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  /** 一般的なプロバイダ既定値（フォームの初期値）。 */
  defaultValue: number;
}

export const PARAM_DEFS: ParamDef[] = [
  {
    key: "temperature",
    label: "Temperature",
    description: "回答のランダムさ。低いほど毎回同じような答えになる",
    min: 0,
    max: 2,
    step: 0.1,
    defaultValue: 1.0,
  },
  {
    key: "top_p",
    label: "Top P",
    description: "確率上位の候補だけから選ぶ割合",
    min: 0,
    max: 1,
    step: 0.05,
    defaultValue: 1.0,
  },
  {
    key: "max_tokens",
    label: "Max Tokens",
    description: "応答の最大トークン数（0 = 制限なし）",
    min: 0,
    max: 128000,
    step: 256,
    defaultValue: 0,
  },
  {
    key: "frequency_penalty",
    label: "Frequency Penalty",
    description: "同じ語の繰り返しを抑える度合い",
    min: -2,
    max: 2,
    step: 0.1,
    defaultValue: 0,
  },
  {
    key: "presence_penalty",
    label: "Presence Penalty",
    description: "既出の話題を避けて新しい話題を促す度合い",
    min: -2,
    max: 2,
    step: 0.1,
    defaultValue: 0,
  },
  {
    key: "repetition_penalty",
    label: "Repetition Penalty",
    description: "繰り返し全般へのペナルティ",
    min: 0,
    max: 2,
    step: 0.05,
    defaultValue: 1.0,
  },
  {
    key: "top_k",
    label: "Top K",
    description: "確率上位K件の候補だけから選ぶ（0 = 無効）",
    min: 0,
    max: 200,
    step: 1,
    defaultValue: 0,
  },
  {
    key: "min_p",
    label: "Min P",
    description: "最有力候補に対する相対確率の足切り",
    min: 0,
    max: 1,
    step: 0.05,
    defaultValue: 0,
  },
];

/** チャットAPIへ中継してよいパラメータ名（許可リスト）。 */
export const ALLOWED_PARAM_KEYS = new Set(PARAM_DEFS.map((p) => p.key));

/** モデルが対応するパラメータ定義だけを返す。 */
export function paramsForModel(supportedParameters: string[]): ParamDef[] {
  const supported = new Set(supportedParameters);
  return PARAM_DEFS.filter((p) => supported.has(p.key));
}

/** 対応パラメータをすべて既定値で埋めた初期設定を返す。 */
export function defaultParams(supportedParameters: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of paramsForModel(supportedParameters)) {
    out[def.key] = def.defaultValue;
  }
  return out;
}

/**
 * API送信用にパラメータを整形する。既定値と同じもの・無効値は省き、
 * max_tokens=0（制限なし）も送らない。
 */
export function paramsForRequest(
  params: Record<string, number> | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!params) return out;
  for (const def of PARAM_DEFS) {
    const value = params[def.key];
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    if (value === def.defaultValue) continue;
    if (def.key === "max_tokens" && value <= 0) continue;
    out[def.key] = value;
  }
  return out;
}
