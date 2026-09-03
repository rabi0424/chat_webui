import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  conversationOrder,
  formatKeys,
  matchShortcut,
  neighborConversation,
  withKeys,
} from "../app/lib/shortcuts";

/**
 * キーボードショートカット（UI-11）の表と判定。
 *
 * 判定は DOM に触らない純粋な関数なので、押し方の組み合わせをここで
 * 網羅する。入力欄の文字を奪わない（⌘ 無しは拾わない）・IME 変換中は
 * 拾わない、の2つが特に大事——壊れると打てなくなる。
 */
const press = (
  key: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean; composing: boolean }> = {},
) => ({
  key,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  isComposing: mods.composing ?? false,
});

describe("表", () => {
  it("同じキーの組み合わせが2つ無い", () => {
    const seen = new Set<string>();
    for (const s of SHORTCUTS) {
      const k = `${s.shift ? "shift+" : ""}${s.key}`;
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
    }
  });
  it("ID が重ならない", () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
  });
});

describe("matchShortcut", () => {
  it("⌘ でも Ctrl でも通る", () => {
    expect(matchShortcut(press("n", { meta: true }))).toBe("new-chat");
    expect(matchShortcut(press("n", { ctrl: true }))).toBe("new-chat");
  });
  it("⌘ 無しは拾わない（入力欄の文字を奪わない）", () => {
    expect(matchShortcut(press("n"))).toBeNull();
    expect(matchShortcut(press("/"))).toBeNull();
  });
  it("⇧ の有無は別のキー", () => {
    expect(matchShortcut(press("m", { meta: true }))).toBeNull();
    // ⇧ を押すと key は大文字で届く
    expect(matchShortcut(press("M", { meta: true, shift: true }))).toBe("model");
    expect(matchShortcut(press("N", { meta: true, shift: true }))).toBeNull();
  });
  it("⌥ 付きは拾わない（文字の入力に使う）", () => {
    expect(matchShortcut(press("n", { meta: true, alt: true }))).toBeNull();
  });
  it("IME の変換中は拾わない", () => {
    expect(matchShortcut(press("n", { meta: true, composing: true }))).toBeNull();
  });
  it("矢印と記号", () => {
    expect(matchShortcut(press("ArrowUp", { meta: true }))).toBe("prev-conversation");
    expect(matchShortcut(press("ArrowDown", { meta: true }))).toBe("next-conversation");
    expect(matchShortcut(press("\\", { meta: true }))).toBe("toggle-sidebar");
    expect(matchShortcut(press("k", { meta: true }))).toBe("search");
    expect(matchShortcut(press("C", { meta: true, shift: true }))).toBe("copy-last");
  });
});

describe("表記", () => {
  const model = SHORTCUTS.find((s) => s.id === "model")!;
  const up = SHORTCUTS.find((s) => s.id === "prev-conversation")!;
  it("Mac は記号、それ以外は Ctrl+", () => {
    expect(formatKeys(model, true)).toBe("⌘⇧M");
    expect(formatKeys(model, false)).toBe("Ctrl+Shift+M");
    expect(formatKeys(up, true)).toBe("⌘↑");
    expect(formatKeys(up, false)).toBe("Ctrl+↑");
  });
  it("title に添える", () => {
    expect(withKeys("新規チャット", "new-chat", true)).toBe("新規チャット (⌘N)");
  });
});

describe("会話の順", () => {
  const c = (
    id: string,
    extra: Partial<{ pinned: number; sort_order: number; folder_id: string | null }> = {},
  ) => ({
    id,
    pinned: extra.pinned ?? 0,
    sort_order: extra.sort_order ?? 0,
    created_at: 0,
    folder_id: extra.folder_id ?? null,
  });

  it("ピン留め → ルート → フォルダの中、の順（サイドバーの見た目と同じ）", () => {
    const order = conversationOrder([
      c("a"),
      c("in-folder", { folder_id: "f1" }),
      c("pin2", { pinned: 1, sort_order: 2 }),
      c("b"),
      c("pin1", { pinned: 1, sort_order: 1 }),
    ]);
    expect(order).toEqual(["pin1", "pin2", "a", "b", "in-folder"]);
  });

  it("隣へ。端では止まり、回り込まない", () => {
    const order = ["a", "b", "c"];
    expect(neighborConversation(order, "b", "next")).toBe("c");
    expect(neighborConversation(order, "b", "prev")).toBe("a");
    expect(neighborConversation(order, "c", "next")).toBeNull();
    expect(neighborConversation(order, "a", "prev")).toBeNull();
  });

  it("会話を開いていないときは ↓ で先頭へ、↑ は動かない", () => {
    const order = ["a", "b"];
    expect(neighborConversation(order, null, "next")).toBe("a");
    expect(neighborConversation(order, null, "prev")).toBeNull();
    expect(neighborConversation([], null, "next")).toBeNull();
  });
});
