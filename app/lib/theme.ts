import { notifyChanged, readRaw, usePersisted, writeRaw } from "./persisted";

/** テーマ設定（ライト / ダーク / 端末設定に合わせる）。 */
export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "chat-webui:theme";

/**
 * ブラウザのステータスバー領域（Safariのタブバー等）に塗られる色。
 * アプリの背景色（app.css の html/body）と一致させることで、
 * スマホでステータスバーとアプリ上端の間に見える境界線をなくす。
 * <meta name="theme-color"> の media 指定はOS設定にしか追従しないため、
 * アプリ内のテーマ切替と同期するようJSで内容を書き換える。
 */
export const THEME_COLOR_LIGHT = "#ffffff";
export const THEME_COLOR_DARK = "#0a0a0a"; // neutral-950

/**
 * ハイドレーション前に実行してちらつきを防ぐインラインスクリプト。
 * root.tsx の <head> に埋め込む（theme-color メタタグより後に置くこと）。
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var t = localStorage.getItem("${THEME_STORAGE_KEY}") || "system";
    var dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", dark ? "${THEME_COLOR_DARK}" : "${THEME_COLOR_LIGHT}");
  } catch (e) {}
})();
`;

/** 保存されている選択。読めなければ「端末に合わせる」。 */
export function getTheme(): Theme {
  const t = readRaw(THEME_STORAGE_KEY);
  return t === "light" || t === "dark" ? t : "system";
}

/**
 * いま選ばれているテーマを購読する。
 *
 * 設定画面とサイドバーのトグルは同じ値を別々に持っていて、片方で変えても
 * もう片方は古い値のままだった（次に押すと一手ずれる）。読む側が
 * 全員ここを通れば揃う。別のタブでの変更も同じ経路で届く。
 */
export function useTheme(): Theme {
  return usePersisted(THEME_STORAGE_KEY, getTheme, "system");
}

/**
 * DOMへ反映するだけ（保存はしない）。
 *
 * 保存と分けてあるのは、端末の外観設定が変わったときの貼り直しでも
 * 使うため。ここで保存まですると、そういう「反映したいだけ」の場面が
 * ユーザーの選択を書き換えてしまう。
 */
export function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? THEME_COLOR_DARK : THEME_COLOR_LIGHT);
}

/** 選択を保存して反映する（ユーザーが切り替えたとき）。 */
export function saveTheme(theme: Theme): void {
  writeRaw(THEME_STORAGE_KEY, theme);
  applyTheme(theme);
  notifyChanged(THEME_STORAGE_KEY);
}

/** 保存値を読み直してDOMへ貼り直す。 */
export function syncTheme(): void {
  applyTheme(getTheme());
}
