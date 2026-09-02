import { notifyChanged, readRaw, usePersisted, writeRaw } from "./persisted";

/**
 * ホーム（新規チャット）の様式。
 *
 * - glass:   淡い環境光の上にすりガラスのカードを並べる
 * - minimal: 大きな挨拶タイポグラフィ + 罫線区切りのリスト
 *
 * 好みは端末ごとでよいので localStorage に持つ（テーマ・文字サイズと同じ）。
 * 切り替えは設定画面の「外観」。以前はホームの下端に切替ボタンがあったが、
 * 製品に「デザインを選ぶ」ボタンが常に見えていると、作り手が決めきれて
 * いないことが伝わる。設定に入れれば、選べることは変わらない。
 */
export type HomeStyle = "glass" | "minimal";

export const HOME_STYLE_STORAGE_KEY = "chat-webui:home-style";

export const HOME_STYLES: { value: HomeStyle; label: string; hint: string }[] = [
  { value: "glass", label: "グラス", hint: "光の上にカードを並べる" },
  { value: "minimal", label: "ミニマル", hint: "大きな挨拶と罫線の一覧" },
];

export const DEFAULT_HOME_STYLE: HomeStyle = "glass";

function isHomeStyle(v: unknown): v is HomeStyle {
  return v === "glass" || v === "minimal";
}

export function getHomeStyle(): HomeStyle {
  const raw = readRaw(HOME_STYLE_STORAGE_KEY);
  return isHomeStyle(raw) ? raw : DEFAULT_HOME_STYLE;
}

/** いま選ばれている様式を購読する。サーバー側では既定。 */
export function useHomeStyle(): HomeStyle {
  return usePersisted(HOME_STYLE_STORAGE_KEY, getHomeStyle, DEFAULT_HOME_STYLE);
}

export function saveHomeStyle(style: HomeStyle): void {
  writeRaw(HOME_STYLE_STORAGE_KEY, style);
  notifyChanged(HOME_STYLE_STORAGE_KEY);
}
