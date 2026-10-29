import { describe, expect, it } from "vitest";
import {
  looksLikePdf,
  matchesDeclared,
  sniffImageFormat,
} from "../app/lib/image-signature";

/**
 * 中身が申告どおりの画像か。
 *
 * アップロードの検査はブラウザが申告する MIME（File.type）だけを見て
 * いた。申告はいくらでも詐称できるので、**中身が画像でないものを画像
 * として保存し、画像として配信する**経路が開いていた。
 */
const bytes = (...b: number[]) => new Uint8Array(b).buffer;

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0);
const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0);
const WEBP = bytes(
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x00, 0x00, 0x00, 0x00, // 長さ
  0x57, 0x45, 0x42, 0x50, // "WEBP"
);
/** HTML。画像として保存されると困るもの。 */
const HTML = new TextEncoder().encode("<html><script>alert(1)</script>").buffer;

describe("中身から形式を読む", () => {
  it("PNG", () => expect(sniffImageFormat(PNG)).toBe("image/png"));
  it("JPEG", () => expect(sniffImageFormat(JPEG)).toBe("image/jpeg"));
  it("GIF", () => expect(sniffImageFormat(GIF)).toBe("image/gif"));
  it("WebP", () => expect(sniffImageFormat(WEBP)).toBe("image/webp"));

  it("画像でないものは分からないと返す", () => {
    expect(sniffImageFormat(HTML)).toBeNull();
    expect(sniffImageFormat(bytes())).toBeNull();
    expect(sniffImageFormat(bytes(0x89))).toBeNull(); // 途中で切れている
  });

  it("RIFF だが WebP でないもの（WAVなど）は通さない", () => {
    const wav = bytes(
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45, // "WAVE"
    );
    expect(sniffImageFormat(wav)).toBeNull();
  });
});

describe("申告との突き合わせ", () => {
  it("合っていれば通す", () => {
    expect(matchesDeclared(PNG, "image/png")).toBe(true);
    expect(matchesDeclared(JPEG, "image/jpeg")).toBe(true);
    expect(matchesDeclared(WEBP, "image/webp")).toBe(true);
  });

  it("image/jpg も JPEG として扱う", () => {
    expect(matchesDeclared(JPEG, "image/jpg")).toBe(true);
  });

  /** これが防ぎたかったところ。 */
  it("画像でないものを画像と申告しても通さない", () => {
    expect(matchesDeclared(HTML, "image/png")).toBe(false);
  });

  it("別の画像形式を名乗っても通さない", () => {
    expect(matchesDeclared(PNG, "image/jpeg")).toBe(false);
    expect(matchesDeclared(GIF, "image/webp")).toBe(false);
  });

  it("知らない形式の申告は通さない", () => {
    expect(matchesDeclared(PNG, "image/svg+xml")).toBe(false);
  });
});

describe("PDF", () => {
  const enc = (s: string) => new TextEncoder().encode(s).buffer;
  const PDF = enc("%PDF-1.7\n%âãÏÓ\n1 0 obj");

  it("%PDF- で始まるものは PDF として通す", () => {
    expect(looksLikePdf(PDF)).toBe(true);
    expect(matchesDeclared(PDF, "application/pdf")).toBe(true);
  });

  /** これが防ぎたかったところ（画像と同じ）。 */
  it("PDF でないものを PDF と申告しても通さない", () => {
    expect(matchesDeclared(HTML, "application/pdf")).toBe(false);
    expect(matchesDeclared(PNG, "application/pdf")).toBe(false);
    expect(matchesDeclared(enc("%PDF"), "application/pdf")).toBe(false); // 途中で切れている
    expect(matchesDeclared(new ArrayBuffer(0), "application/pdf")).toBe(false);
  });

  it("PDF を画像と申告しても通さない", () => {
    expect(matchesDeclared(PDF, "image/png")).toBe(false);
  });

  /*
   * 手前に余計なものが付いた PDF も、ビューアは開く。先頭だけを見ると
   * 開ける PDF が断られる。境目の両側を確かめる（1024 バイトの内に
   * 目印が収まるか）
   */
  it("先頭 1024 バイトの中に目印があれば通し、外なら通さない", () => {
    const inside = enc(`${" ".repeat(1024 - 5)}%PDF-`);
    const outside = enc(`${" ".repeat(1024 - 4)}%PDF-`);
    expect(looksLikePdf(inside)).toBe(true);
    expect(looksLikePdf(outside)).toBe(false);
  });
});
