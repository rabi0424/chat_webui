/**
 * アクセント（ハイライト）カラー。
 *
 * macOSのアクセントカラーと同じ考え方で、システム全体の強調色を
 * ユーザーが切り替えられる。実体は CSS 変数（--accent / --accent-fg）で、
 * <html data-accent="..."> により app.css 内の定義が切り替わる。
 * Tailwind からは `bg-accent` `text-accent` 等のユーティリティで参照する
 * （app.css の @theme inline を参照）。
 */

export interface AccentDef {
  id: string;
  label: string;
  /** ピッカーの色見本に使う代表色（ライトモードの値）。 */
  swatch: string;
}

/** macOS System Settings と同じ並び。 */
export const ACCENTS: AccentDef[] = [
  { id: "blue", label: "ブルー", swatch: "#007aff" },
  { id: "cyan", label: "シアン", swatch: "#32ade6" },
  { id: "purple", label: "パープル", swatch: "#af52de" },
  { id: "pink", label: "ピンク", swatch: "#ff2d55" },
  { id: "red", label: "レッド", swatch: "#ff3b30" },
  { id: "orange", label: "オレンジ", swatch: "#ff9500" },
  { id: "yellow", label: "イエロー", swatch: "#ffcc00" },
  { id: "green", label: "グリーン", swatch: "#34c759" },
  { id: "graphite", label: "グラファイト", swatch: "#8e8e93" },
];

export const DEFAULT_ACCENT = "blue";

export const ACCENT_STORAGE_KEY = "chat-webui:accent";

/**
 * ハイドレーション前に実行してちらつきを防ぐインラインスクリプト。
 * root.tsx の <head> に埋め込む（テーマ初期化と同様）。
 */
export const ACCENT_INIT_SCRIPT = `
(function () {
  try {
    var a = localStorage.getItem("${ACCENT_STORAGE_KEY}");
    if (a) document.documentElement.dataset.accent = a;
  } catch (e) {}
})();
`;

export function getAccent(): string {
  try {
    const a = localStorage.getItem(ACCENT_STORAGE_KEY);
    return a && ACCENTS.some((x) => x.id === a) ? a : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

/** DOMへ反映するだけ（保存はしない）。理由は lib/theme.ts と同じ。 */
export function applyAccent(id: string): void {
  document.documentElement.dataset.accent = id;
}

/** 選択を保存して反映する。 */
export function saveAccent(id: string): void {
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, id);
  } catch {
    // 保存できなくても、この画面のあいだは反映しておく
  }
  applyAccent(id);
}

/** 保存値を読み直してDOMへ貼り直す。 */
export function syncAccent(): void {
  applyAccent(getAccent());
}
