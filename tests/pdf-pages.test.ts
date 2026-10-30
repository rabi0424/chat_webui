import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { countPdfPages } from "../app/lib/pdf-pages";

/**
 * PDF の頁数（OCR の見積もり）。
 *
 * 手で書いた PDF だけで確かめると、「PDF はこう書かれているはず」という
 * 推測をそのまま検査することになる。実際に出回る書き出しで試す:
 *   - chromium-3pages.pdf: Chromium の印刷（頁の木が素のまま）
 *   - cairo-3pages.pdf: cairo（pdftocairo）の書き出し。頁の木が圧縮した
 *     入れ物（/ObjStm）の中にあり、外からは /Count が1つも見えない
 *   - poppler-6pages.pdf: poppler（pdfunite）で2つを繋いだもの
 * 頁数は poppler の pdfinfo が数えたものと同じ（3・3・6）。
 */
function fixture(name: string): ArrayBuffer {
  const b = readFileSync(join(process.cwd(), "tests/fixtures", name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const enc = (s: string) => new TextEncoder().encode(s);
function concat(...parts: Uint8Array[]): ArrayBuffer {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

describe("実際の書き出し", () => {
  it("Chromium の PDF（頁の木が素のまま）", async () => {
    expect(await countPdfPages(fixture("chromium-3pages.pdf"))).toBe(3);
  });

  it("cairo の PDF（頁の木が圧縮した入れ物の中）", async () => {
    expect(await countPdfPages(fixture("cairo-3pages.pdf"))).toBe(3);
  });

  it("繋いだ PDF は、途中の節ではなく根の数を採る", async () => {
    expect(await countPdfPages(fixture("poppler-6pages.pdf"))).toBe(6);
  });
});

describe("書き方の違い", () => {
  it("途中の節の数より、根の数（いちばん大きいもの）を採る", async () => {
    const pdf = enc(
      "%PDF-1.4\n" +
        "1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] /Count 7 >> endobj\n" +
        "2 0 obj << /Type /Pages /Parent 1 0 R /Kids [] /Count 4 >> endobj\n" +
        "3 0 obj << /Type /Pages /Parent 1 0 R /Kids [] /Count 3 >> endobj\n",
    );
    expect(await countPdfPages(pdf.buffer as ArrayBuffer)).toBe(7);
  });

  it("空白を詰めた書き方（/Type/Pages）も読む", async () => {
    const pdf = enc("%PDF-1.4\n1 0 obj<</Type/Pages/Count 12/Kids[]>>endobj\n");
    expect(await countPdfPages(pdf.buffer as ArrayBuffer)).toBe(12);
  });

  it("/Count は同じ辞書のものだけを見る（隣の目次の数を拾わない）", async () => {
    // 目次（/Outlines）も /Count を持つ。辞書の端を見ないと隣のものを拾う
    const pdf = enc(
      "%PDF-1.4\n" +
        "1 0 obj << /Type /Outlines /Count 99 >> endobj\n" +
        "2 0 obj << /Type /Pages /Kids [] /Count 2 >> endobj\n",
    );
    expect(await countPdfPages(pdf.buffer as ArrayBuffer)).toBe(2);
  });

  it("/Count が /Type より前にあっても、同じ辞書のものを拾う", async () => {
    // 辞書の中の並びは書き出しごとに違う。/Type の後ろだけを見ると、
    // 自分の /Count を見落として隣の目次の数を拾う
    const pdf = enc(
      "%PDF-1.4\n" +
        "1 0 obj << /Count 4 /Kids [] /Type /Pages >> endobj\n" +
        "2 0 obj << /Type /Outlines /Count 99 >> endobj\n",
    );
    expect(await countPdfPages(pdf.buffer as ArrayBuffer)).toBe(4);
  });

  it("入れ子の辞書があっても、同じ辞書の /Count を拾う", async () => {
    const pdf = enc(
      "%PDF-1.4\n2 0 obj << /Type /Pages /Resources << /Font << /F1 5 0 R >> >> /Count 5 /Kids [] >> endobj\n",
    );
    expect(await countPdfPages(pdf.buffer as ArrayBuffer)).toBe(5);
  });

  it("頁（/Page）の辞書を頁の木（/Pages）と取り違えない", async () => {
    const pdf = enc("%PDF-1.4\n3 0 obj << /Type /Page /Count 40 >> endobj\n");
    expect(await countPdfPages(pdf.buffer as ArrayBuffer)).toBeNull();
  });

  it("線形化された PDF は、先頭の頁数を使う（入れ物を開かずに済む）", async () => {
    const pdf = enc(
      "%PDF-1.5\n1 0 obj << /Linearized 1 /L 1000 /N 9 /T 900 >> endobj\n",
    );
    expect(await countPdfPages(pdf.buffer as ArrayBuffer)).toBe(9);
  });

  it("長さが数で書かれた入れ物は、その長さだけ読む", async () => {
    // 本体の末尾の改行は本体の一部かもしれない（圧縮した中身のバイト）。
    // 長さが分かるときに endstream まで取って改行を落とすと、壊れる
    const body = deflateSync(Buffer.from("<< /Type /Pages /Count 23 /Kids [] >>"));
    const pdf = concat(
      enc(`%PDF-1.5\n5 0 obj << /Type /ObjStm /Filter /FlateDecode /Length ${body.length} >>\nstream\n`),
      body,
      enc("\nendstream endobj\n"),
    );
    expect(body.length).toBeGreaterThanOrEqual(10); // 2桁の長さを読ませる
    expect(await countPdfPages(pdf)).toBe(23);
  });

  it("長さが間接参照の入れ物も開く（endstream まで取る）", async () => {
    const body = deflateSync(Buffer.from("<< /Type /Pages /Count 11 /Kids [] >>"));
    const pdf = concat(
      enc("%PDF-1.5\n5 0 obj << /Type /ObjStm /N 1 /First 0 /Filter /FlateDecode /Length 6 0 R >>\nstream\r\n"),
      body,
      enc("\r\nendstream endobj\n6 0 obj 99 endobj\n"),
    );
    expect(await countPdfPages(pdf)).toBe(11);
  });
});

describe("分からないとき", () => {
  /** 0 頁にすると、有料の OCR が無料に見える。 */
  it("頁の木が見つからなければ null", async () => {
    expect(await countPdfPages(enc("%PDF-1.4\n").buffer as ArrayBuffer)).toBeNull();
    expect(await countPdfPages(new ArrayBuffer(0))).toBeNull();
  });

  it("開けない入れ物（暗号化・壊れている）は飛ばして null", async () => {
    const pdf = enc(
      "%PDF-1.5\n5 0 obj << /Type /ObjStm /Filter /FlateDecode /Length 8 >>\nstream\nnotzlib!\nendstream endobj\n",
    );
    expect(await countPdfPages(pdf.buffer as ArrayBuffer)).toBeNull();
  });
});
