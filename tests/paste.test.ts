import { describe, expect, it } from "vitest";
import {
  PASTE_COLLAPSE_CHARS,
  PASTE_COLLAPSE_LINES,
  expandOnePaste,
  expandPastes,
  insertPasteToken,
  nextPasteNumber,
  pasteNumbersIn,
  pasteToken,
  removePasteToken,
  shouldCollapsePaste,
} from "../app/lib/paste";

/**
 * 長い貼り付けの畳み方。畳むのは見た目だけで、送るときは本文へ戻す。
 * ここが崩れると、貼った内容がモデルへ届かない（札のまま送られる）か、
 * 短い貼り付けまで札になって打ち心地が変わる。
 */
describe("畳むかどうか", () => {
  it("文字数か行数のどちらかが上限に届けば畳む", () => {
    expect(shouldCollapsePaste("a".repeat(PASTE_COLLAPSE_CHARS))).toBe(true);
    expect(shouldCollapsePaste("a".repeat(PASTE_COLLAPSE_CHARS - 1))).toBe(false);
    expect(shouldCollapsePaste("x\n".repeat(PASTE_COLLAPSE_LINES - 1) + "x")).toBe(true);
    expect(shouldCollapsePaste("x\n".repeat(PASTE_COLLAPSE_LINES - 2) + "x")).toBe(false);
  });
});

describe("札の出し入れ", () => {
  const paste = { n: 1, text: "行1\n行2\n行3" };

  it("選択範囲を札で置き換え、キャレットは札の直後", () => {
    const r = insertPasteToken("前 後", { start: 2, end: 2 }, paste);
    expect(r.text).toBe(`前 ${pasteToken(paste)}後`);
    expect(r.caret).toBe(2 + pasteToken(paste).length);
  });

  it("送るときは札が本文に戻る。貼り付けの無い札はそのまま", () => {
    const text = `依頼: ${pasteToken(paste)} と [貼り付け #9: 3行]`;
    expect(expandPastes(text, [paste])).toBe(
      "依頼: 行1\n行2\n行3 と [貼り付け #9: 3行]",
    );
  });

  it("本文に残っている札の番号が分かる（消した札は数えない）", () => {
    const p2 = { n: 2, text: "b" };
    const text = `${pasteToken(paste)} x ${pasteToken(p2)}`;
    expect([...pasteNumbersIn(text)].sort()).toEqual([1, 2]);
    expect([...pasteNumbersIn(removePasteToken(text, paste))]).toEqual([2]);
  });

  it("番号は使い回さない", () => {
    expect(nextPasteNumber([])).toBe(1);
    expect(nextPasteNumber([{ n: 3, text: "" }])).toBe(4);
  });

  it("1つだけ展開できる", () => {
    const p2 = { n: 2, text: "b" };
    const text = `${pasteToken(paste)}|${pasteToken(p2)}`;
    expect(expandOnePaste(text, p2)).toBe(`${pasteToken(paste)}|b`);
  });
});
