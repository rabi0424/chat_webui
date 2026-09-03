/**
 * キーボードショートカット（UI-11）。
 *
 * 表は**ここ1か所**に持ち、⌘/ の一覧もこの表から描く。表とハンドラが
 * 別々だと、後から足したキーが一覧に出ない（出ないキーは無いのと同じ）。
 *
 * どれも ⌘（Windows では Ctrl）付きだけを拾う。入力欄にフォーカスが
 * あるときに素のキーを奪うと、文字が打てなくなる。IME の変換中
 * （isComposing）は何もしない——Enter 送信と同じガード。
 *
 * DOM にもルーターにも触らない純粋な表と判定だけを置く（テストしやすさ
 * のため）。拾って配るのは shell、受けるのは各画面（`useShortcut`）。
 */

export type ShortcutId =
  | "new-chat"
  | "search"
  | "toggle-sidebar"
  | "model"
  | "copy-last"
  | "prev-conversation"
  | "next-conversation"
  | "help";

export interface Shortcut {
  id: ShortcutId;
  /** KeyboardEvent.key と比べる値（文字は小文字）。 */
  key: string;
  /** ⇧ も要るか。要らないものに ⇧ が付いていたら別のキーとして扱う。 */
  shift?: boolean;
  /** 一覧に出す説明。 */
  label: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "new-chat", key: "n", label: "新規チャット" },
  { id: "search", key: "k", label: "会話を検索" },
  { id: "toggle-sidebar", key: "\\", label: "サイドバーを畳む／開く" },
  { id: "model", key: "m", shift: true, label: "モデルを選ぶ" },
  { id: "copy-last", key: "c", shift: true, label: "最後の応答をコピー" },
  { id: "prev-conversation", key: "ArrowUp", label: "前の会話へ" },
  { id: "next-conversation", key: "ArrowDown", label: "次の会話へ" },
  { id: "help", key: "/", label: "ショートカットの一覧" },
];

/** KeyboardEvent のうち、判定に使う部分。 */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

/**
 * 押されたキーがどのショートカットか。該当しなければ null。
 *
 * ⌘ と Ctrl はどちらでも通す（Mac では ⌘、Windows では Ctrl）。⌥ が
 * 付いていたら別物（⌥ 付きは文字の入力に使う）。
 */
export function matchShortcut(e: KeyLike): ShortcutId | null {
  if (e.isComposing) return null;
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  // ⇧ を押すと key が大文字や記号になる（⇧M → "M"、⇧/ → "?"）ので、
  // 文字は code に近い形へ寄せる。矢印などはそのまま
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const s of SHORTCUTS) {
    if (s.key !== key) continue;
    if (Boolean(s.shift) !== e.shiftKey) continue;
    return s.id;
  }
  return null;
}

/** 一覧に出す表記。Mac は記号、それ以外は "Ctrl+Shift+M"。 */
export function formatKeys(s: Shortcut, mac: boolean): string {
  const name =
    s.key === "ArrowUp"
      ? "↑"
      : s.key === "ArrowDown"
        ? "↓"
        : s.key.length === 1
          ? s.key.toUpperCase()
          : s.key;
  if (mac) return `⌘${s.shift ? "⇧" : ""}${name}`;
  return ["Ctrl", s.shift ? "Shift" : null, name].filter(Boolean).join("+");
}

/** title 属性に添える形（「新規チャット (⌘N)」）。 */
export function withKeys(label: string, id: ShortcutId, mac: boolean): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? `${label} (${formatKeys(s, mac)})` : label;
}

/** サイドバーの並びを決めるのに要る分だけ。 */
export interface OrderableConversation {
  id: string;
  pinned: number;
  sort_order: number;
  created_at: number;
  folder_id: string | null;
}

/**
 * ⌘↑ / ⌘↓ で辿る順。サイドバーの見た目の並びに合わせる——
 * ピン留め（並び順）→ フォルダに入っていない会話（一覧の順のまま）→
 * フォルダの中の会話。見えている順と違う順で飛ぶと、どこへ行ったか
 * 分からなくなる。
 */
export function conversationOrder(list: readonly OrderableConversation[]): string[] {
  const pinned = list
    .filter((c) => c.pinned)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
  const root = list.filter((c) => !c.pinned && c.folder_id == null);
  const inFolder = list.filter((c) => !c.pinned && c.folder_id != null);
  return [...pinned, ...root, ...inFolder].map((c) => c.id);
}

/**
 * いまの会話の隣。端では null（回り込まない——最後の次が最初に飛ぶと、
 * 押しすぎたときに「戻った」のか「一周した」のか分からない）。
 * いまの会話が無い（ホームなど）ときは、↓ で先頭へ、↑ では動かない。
 */
export function neighborConversation(
  order: readonly string[],
  currentId: string | null,
  direction: "prev" | "next",
): string | null {
  if (order.length === 0) return null;
  const i = currentId ? order.indexOf(currentId) : -1;
  if (i < 0) return direction === "next" ? order[0] : null;
  const j = direction === "next" ? i + 1 : i - 1;
  return j >= 0 && j < order.length ? order[j] : null;
}
