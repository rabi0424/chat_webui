import { describe, expect, it } from "vitest";
import {
  decodeText,
  isTextFile,
  readTextFile,
  textFileContentType,
  TEXT_FILE_ACCEPT,
} from "../app/lib/text-file";
import { IMAGE_ACCEPT } from "../app/lib/constants";

/**
 * 落とされたテキストファイルの読み取り。
 *
 * ここが外すと、**読み違えたことに気づけないまま答えが返る**——化けた
 * 文字にもモデルは何か答えるので、画面を見ても分からない。判定と
 * 文字コードは、実際のバイト列で確かめる。
 */

const file = (name: string, body: Uint8Array | string, type = "") =>
  new File([body as BlobPart], name, { type });

describe("テキストファイルかどうか", () => {
  it("文章・データ・コードの拡張子を受ける", () => {
    for (const name of ["a.txt", "a.md", "a.html", "a.csv", "a.json", "a.py"]) {
      expect(isTextFile(file(name, "x")), name).toBe(true);
    }
  });

  /*
   * 多くの環境で `.ts` は `video/mp2t`（MPEG transport stream）と
   * 申告される。MIME を先に見ていると、TypeScript のファイルが
   * 動画として弾かれる——拡張子で見ていることを、この形で見張る。
   */
  it("MIME が動画だと言っても、拡張子がテキストなら受ける", () => {
    expect(isTextFile(file("a.ts", "x", "video/mp2t"))).toBe(true);
  });

  it("一覧に無い拡張子でも、OS がテキストだと言えば受ける", () => {
    expect(isTextFile(file("a.鍵", "x", "text/plain"))).toBe(true);
  });

  it("画像とその他のファイルは受けない", () => {
    for (const [name, type] of [
      ["a.png", "image/png"],
      ["a.svg", "image/svg+xml"],
      ["a.pdf", "application/pdf"],
      ["a.zip", "application/zip"],
      ["a.docx", ""],
    ]) {
      expect(isTextFile(file(name, "x", type)), name).toBe(false);
    }
  });

  it("HTML だけが本文の取り出しを通る", () => {
    expect(textFileContentType("a.html")).toBe("text/html");
    expect(textFileContentType("A.HTM")).toBe("text/html");
    expect(textFileContentType("a.txt")).toBe("text/plain");
    // 名前に .html を含むだけのものは HTML ではない
    expect(textFileContentType("a.html.txt")).toBe("text/plain");
  });

  /*
   * 選択画面で灰色にならないことは `accept` でしか決まらない。
   * 受け入れる拡張子を足しても accept に載らなければ、**ファイルは
   * 正しいのに選択画面から消える**（ドロップだけが通る、という
   * 食い違いになる）。一覧が accept の出どころであることを見張る。
   */
  it("受け入れる拡張子は、そのまま選択画面の accept になる", () => {
    for (const ext of [".txt", ".html", ".md", ".py"]) {
      expect(TEXT_FILE_ACCEPT, ext).toContain(ext);
    }
    // 画像は MIME だけでなく拡張子も並べる（OS の登録が無い環境向け）
    expect(IMAGE_ACCEPT).toContain("image/webp");
    expect(IMAGE_ACCEPT).toContain(".webp");
  });
});

/** Shift_JIS の「日本語」（0x93 0xfa 0x96 0x7b 0x8c 0xea）。 */
const SJIS_NIHONGO = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

describe("文字コードの見分け", () => {
  it("UTF-8 の日本語をそのまま読む", () => {
    const bytes = new TextEncoder().encode("日本語のテキスト");
    expect(decodeText(bytes.buffer as ArrayBuffer)).toBe("日本語のテキスト");
  });

  /*
   * 表計算から書き出した .csv は Shift_JIS のことがある。UTF-8 と
   * 決め打つと `���{��` のような本文がそのままモデルへ渡る。
   */
  it("Shift_JIS の日本語を読む", () => {
    expect(decodeText(SJIS_NIHONGO.buffer as ArrayBuffer)).toBe("日本語");
  });

  it("BOM は落として読む（本文の頭に見えない字を残さない）", () => {
    const body = new TextEncoder().encode("あ");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    expect(decodeText(withBom.buffer as ArrayBuffer)).toBe("あ");

    const utf16 = new Uint8Array([0xff, 0xfe, 0x42, 0x30]); // BOM + あ
    expect(decodeText(utf16.buffer as ArrayBuffer)).toBe("あ");
  });

  /*
   * ASCII だけの本文は UTF-8 としても Shift_JIS としても読める。
   * 先に UTF-8 を試すので、どちらでも同じ結果になることを確かめる
   * （順序を入れ替えても壊れない、という意味ではない——下の
   * 「UTF-8 を先に試す」で順序そのものを見張る）。
   */
  it("ASCII はどちらの符号化でも同じ", () => {
    const bytes = new TextEncoder().encode("hello, world");
    expect(decodeText(bytes.buffer as ArrayBuffer)).toBe("hello, world");
  });

  /*
   * UTF-8 を先に試すこと自体を見張る。
   *
   * **試す語を選ばないと、この検査は何もしない。** 「日本語」の UTF-8 は
   * 末尾が Shift_JIS の先導バイトで終わるので、誤りを許さない設定なら
   * Shift_JIS 側が例外を投げる——順序を入れ替えても結果が変わらず、
   * 通っているだけのテストになる（実際にそうなった）。
   *
   * 「こんにちは」の UTF-8 は Shift_JIS としても最後まで読め、
   * 「縺薙ｓ縺ｫ縺｡縺ｯ」という別の字が並ぶ。順序を入れ替えれば化ける。
   */
  it("UTF-8 を先に試す（Shift_JIS が先だと UTF-8 が化ける）", () => {
    const utf8 = new TextEncoder().encode("こんにちは");
    // 順序を入れ替えたときに何が起きるか（Shift_JIS でも最後まで読める）
    expect(new TextDecoder("shift_jis", { fatal: true }).decode(utf8)).toBe(
      "縺薙ｓ縺ｫ縺｡縺ｯ",
    );
    expect(decodeText(utf8.buffer as ArrayBuffer)).toBe("こんにちは");
  });
});

describe("読み取り", () => {
  it("上限より小さければ丸ごと読む", async () => {
    const read = await readTextFile(file("a.txt", "あいうえお"), 1024);
    expect(read).toEqual({
      name: "a.txt",
      contentType: "text/plain",
      body: "あいうえお",
      truncated: false,
    });
  });

  /*
   * 字数の上限（`pageMaxChars`）より前に、バイトで切る。数百MBの
   * ログを丸ごとメモリへ載せないため。
   */
  it("上限を超えるぶんは切り、切ったことを残す", async () => {
    const read = await readTextFile(file("big.log", "0123456789"), 4);
    expect(read.body).toBe("0123");
    expect(read.truncated).toBe(true);
  });

  it("HTML は本文の取り出しへ渡す種別になる", async () => {
    const read = await readTextFile(file("a.html", "<p>x</p>"), 1024);
    expect(read.contentType).toBe("text/html");
  });
});
