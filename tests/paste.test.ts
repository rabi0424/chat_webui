import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASTE_THRESHOLD,
  PASTE_CHARS_RANGE,
  readPasteThreshold,
  savePasteThreshold,
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
  const { chars, lines } = DEFAULT_PASTE_THRESHOLD;

  it("文字数か行数のどちらかが上限に届けば畳む", () => {
    expect(shouldCollapsePaste("a".repeat(chars))).toBe(true);
    expect(shouldCollapsePaste("a".repeat(chars - 1))).toBe(false);
    expect(shouldCollapsePaste("x\n".repeat(lines - 1) + "x")).toBe(true);
    expect(shouldCollapsePaste("x\n".repeat(lines - 2) + "x")).toBe(false);
  });

  it("しきい値は設定で変えられ、0 はその条件で畳まない", () => {
    const t = { chars: 0, lines: 3 };
    expect(shouldCollapsePaste("a".repeat(5000), t)).toBe(false);
    expect(shouldCollapsePaste("a\nb\nc", t)).toBe(true);
    expect(shouldCollapsePaste("a\nb\nc", { chars: 0, lines: 0 })).toBe(false);
  });
});

/**
 * しきい値の保存。壊れた値や範囲外は既定へ戻す（0 が「畳まない」を
 * 意味するので、NaN を 0 にしてしまうと黙って畳まなくなる）。
 */
describe("しきい値の保存", () => {
  it("保存した値を読み戻し、範囲に収める", () => {
    localStorage.clear();
    expect(readPasteThreshold()).toEqual(DEFAULT_PASTE_THRESHOLD);
    savePasteThreshold({ chars: 500, lines: 4 });
    expect(readPasteThreshold()).toEqual({ chars: 500, lines: 4 });
    savePasteThreshold({ chars: 10 ** 9, lines: -5 });
    expect(readPasteThreshold()).toEqual({ chars: PASTE_CHARS_RANGE.max, lines: 0 });
  });

  it("壊れた保存値は既定へ", () => {
    localStorage.setItem("chat-webui:paste-threshold", "{not json");
    expect(readPasteThreshold()).toEqual(DEFAULT_PASTE_THRESHOLD);
    localStorage.setItem("chat-webui:paste-threshold", JSON.stringify({ chars: "abc" }));
    expect(readPasteThreshold()).toEqual(DEFAULT_PASTE_THRESHOLD);
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
