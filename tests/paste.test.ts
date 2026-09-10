import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASTE_THRESHOLD,
  PASTE_CHARS_RANGE,
  readPasteThreshold,
  savePasteThreshold,
  expandOnePaste,
  keepPasteTokensWhole,
  snapSelectionOutsideTokens,
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

/**
 * 札は塊。1文字でも消したら「ただの文字列」に戻って貼り付けとの
 * 結び付きが切れる（送るときに戻らない）ので、札に食い込む編集は
 * 札ごと消す。端に触れるだけの編集は素通し。
 */
describe("札を塊として扱う", () => {
  const paste = { n: 1, text: "a\nb" };
  const token = pasteToken(paste); // [貼り付け #1: 2行]
  const text = `前${token}後`;

  it("札の末尾の1文字を消したら、札ごと消える", () => {
    const after = `前${token.slice(0, -1)}後`;
    expect(keepPasteTokensWhole(text, after)).toEqual({ text: "前後", caret: 1 });
  });

  it("札の先頭の1文字を消しても同じ", () => {
    const after = `前${token.slice(1)}後`;
    expect(keepPasteTokensWhole(text, after)).toEqual({ text: "前後", caret: 1 });
  });

  it("札の途中に文字を打ったら、札が消えて打った文字が残る", () => {
    const after = `前${token.slice(0, 3)}X${token.slice(3)}後`;
    expect(keepPasteTokensWhole(text, after)).toEqual({ text: "前X後", caret: 2 });
  });

  it("札にまたがる選択を置き換えたら、札全体が置き換わる", () => {
    const after = `前${token.slice(0, 4)}Y`;
    // 「札の途中〜末尾の『後』」を Y に置き換えた
    expect(keepPasteTokensWhole(text, after)).toEqual({ text: "前Y", caret: 2 });
  });

  it("札の直前・直後の編集は札に触れていない", () => {
    expect(keepPasteTokensWhole(text, `${token}後`)).toBeNull(); // 「前」を消す
    expect(keepPasteTokensWhole(text, `前${token}`)).toBeNull(); // 「後」を消す
    expect(keepPasteTokensWhole(text, `前${token}X後`)).toBeNull(); // 直後に打つ
    expect(keepPasteTokensWhole(text, `前X${token}後`)).toBeNull(); // 直前に打つ
  });

  it("札ごと選んで消すのは、そのまま", () => {
    expect(keepPasteTokensWhole(text, "前後")).toBeNull();
  });
});

describe("キャレットは札の外へ", () => {
  const token = pasteToken({ n: 1, text: "a\nb" });
  const text = `前${token}後`;
  const ts = 1;
  const te = 1 + token.length;

  it("札の中に置かれた点は近いほうの端へ", () => {
    expect(snapSelectionOutsideTokens(text, { start: ts + 1, end: ts + 1 })).toEqual({ start: ts, end: ts });
    expect(snapSelectionOutsideTokens(text, { start: te - 1, end: te - 1 })).toEqual({ start: te, end: te });
  });

  it("札にまたがる範囲は外側へ広がる", () => {
    expect(snapSelectionOutsideTokens(text, { start: 0, end: ts + 2 })).toEqual({ start: 0, end: te });
    expect(snapSelectionOutsideTokens(text, { start: te - 2, end: te + 1 })).toEqual({ start: ts, end: te + 1 });
  });

  it("端に居るなら動かさない", () => {
    expect(snapSelectionOutsideTokens(text, { start: ts, end: ts })).toBeNull();
    expect(snapSelectionOutsideTokens(text, { start: te, end: te })).toBeNull();
    expect(snapSelectionOutsideTokens(text, { start: ts, end: te })).toBeNull();
  });
});
