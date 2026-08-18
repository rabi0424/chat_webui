/**
 * チャット本文の文字サイズ。
 *
 * テーマ・アクセント色と同じく「その端末での読みやすさ」の話なので、
 * D1ではなく localStorage に置く（スマホは大きく、デスクトップは標準、
 * といった使い分けができる）。実際の大きさは :root の CSS変数
 * --chat-font-scale を通じて app.css の .chat-text に効く。
 */
export type ChatFontSize = "s" | "m" | "l" | "xl";

export const CHAT_FONT_STORAGE_KEY = "chat-webui:chat-font";

export const CHAT_FONT_SIZES: {
  value: ChatFontSize;
  label: string;
  scale: number;
}[] = [
  { value: "s", label: "小", scale: 0.9 },
  { value: "m", label: "標準", scale: 1 },
  { value: "l", label: "大", scale: 1.13 },
  { value: "xl", label: "特大", scale: 1.28 },
];

export const DEFAULT_CHAT_FONT_SIZE: ChatFontSize = "m";

export function chatFontScale(size: ChatFontSize): number {
  return (
    CHAT_FONT_SIZES.find((s) => s.value === size)?.scale ??
    CHAT_FONT_SIZES[1].scale
  );
}

/**
 * ハイドレーション前に実行して、既定サイズで一瞬描かれるのを防ぐ。
 * root.tsx の <head> にテーマ・アクセントと並べて埋め込む。
 */
export const CHAT_FONT_INIT_SCRIPT = `
(function () {
  try {
    var v = localStorage.getItem("${CHAT_FONT_STORAGE_KEY}");
    var m = ${JSON.stringify(
      Object.fromEntries(CHAT_FONT_SIZES.map((s) => [s.value, s.scale])),
    )};
    if (v && m[v]) document.documentElement.style.setProperty("--chat-font-scale", String(m[v]));
  } catch (e) {}
})();
`;

export function getChatFontSize(): ChatFontSize {
  try {
    const v = localStorage.getItem(CHAT_FONT_STORAGE_KEY);
    return CHAT_FONT_SIZES.some((s) => s.value === v)
      ? (v as ChatFontSize)
      : DEFAULT_CHAT_FONT_SIZE;
  } catch {
    return DEFAULT_CHAT_FONT_SIZE;
  }
}

/** DOMへ反映するだけ（保存はしない）。理由は lib/theme.ts と同じ。 */
export function applyChatFontSize(size: ChatFontSize): void {
  document.documentElement.style.setProperty(
    "--chat-font-scale",
    String(chatFontScale(size)),
  );
}

/** 選択を保存して反映する。 */
export function saveChatFontSize(size: ChatFontSize): void {
  try {
    localStorage.setItem(CHAT_FONT_STORAGE_KEY, size);
  } catch {
    // 保存できなくても、この画面のあいだは反映しておく
  }
  applyChatFontSize(size);
}

/** 保存値を読み直してDOMへ貼り直す。 */
export function syncChatFontSize(): void {
  applyChatFontSize(getChatFontSize());
}
