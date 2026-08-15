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

export function getTheme(): Theme {
  const t = localStorage.getItem(THEME_STORAGE_KEY);
  return t === "light" || t === "dark" ? t : "system";
}

export function applyTheme(theme: Theme): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? THEME_COLOR_DARK : THEME_COLOR_LIGHT);
}
