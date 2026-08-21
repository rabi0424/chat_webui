/**
 * モデル一覧の持ち越し。
 *
 * 起動直後にモデル選択を使えるよう、前回取った一覧を localStorage に
 * 置いて即座に出す。裏で取り直して差し替える。
 *
 * 読むときは形を確かめる。ここは JSON.parse の結果をそのまま
 * ModelInfo[] として扱っていたが、中身は前のバージョンのアプリが
 * 書いたものかもしれず、手で書き換えることもできる。使う側は
 * `outputModalities.includes(...)` のように**中の配列を前提に**
 * しているので、形が違うとその場で例外になり、画面が丸ごと落ちる。
 * 表示が少し遅くなるより悪い結果なので、怪しいものは捨てる。
 */
import type { ModelInfo } from "./openrouter.server";
import { readRaw, writeRaw } from "./persisted";

export const MODELS_CACHE_KEY = "chat-webui:models";

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** 使う側が前提にしている項目だけを確かめる。 */
function isModelInfo(v: unknown): v is ModelInfo {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    m.id !== "" &&
    typeof m.name === "string" &&
    isStringArray(m.inputModalities) &&
    isStringArray(m.outputModalities) &&
    isStringArray(m.supportedParameters)
  );
}

/**
 * 持ち越した一覧を読む。
 *
 * 1件でも形が違えば、その1件だけを落とす（全部捨てると、1件の
 * 壊れで起動の速さを毎回失う）。何も残らなければ空を返す。
 */
export function readCachedModels(): ModelInfo[] {
  const raw = readRaw(MODELS_CACHE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isModelInfo);
  } catch {
    return [];
  }
}

export function writeCachedModels(models: ModelInfo[]): void {
  try {
    writeRaw(MODELS_CACHE_KEY, JSON.stringify(models));
  } catch {
    // 容量超過などで保存できなくても、次回起動が少し遅いだけ
  }
}
