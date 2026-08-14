/** テーマ設定（ライト / ダーク / 端末設定に合わせる）。 */
export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "chat-webui:theme";

/**
 * ハイドレーション前に実行してちらつきを防ぐインラインスクリプト。
 * root.tsx の <head> に埋め込む。
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var t = localStorage.getItem("${THEME_STORAGE_KEY}") || "system";
    var dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
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
}
