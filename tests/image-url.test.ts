import { describe, expect, it } from "vitest";
import { looksLikeImageUrl } from "../app/lib/image-url";

/**
 * 応答の中の裸のURLが画像を指していそうか。
 *
 * 当たると、サーバーがその URL を取りに行って R2 へ移す。外れると
 * 画像でないページを1件ぶん取りに行くことになり、上限のある外部
 * リクエストの枠が無駄に減る（無料プランでは1回の実行あたり50件）。
 *
 * 以前は「文字列の末尾が .png か」で見ていたので、クエリの末尾が
 * 拡張子で終わるものまで拾っていた。
 */
describe("画像として取りに行くもの", () => {
  it("素の画像URL", () => {
    expect(looksLikeImageUrl("https://cdn.example.com/a.png")).toBe(true);
    expect(looksLikeImageUrl("https://cdn.example.com/a.JPEG")).toBe(true);
    expect(looksLikeImageUrl("https://cdn.example.com/a.webp")).toBe(true);
  });

  it("クエリが付いていても、パスが画像なら取りに行く", () => {
    expect(
      looksLikeImageUrl("https://cdn.example.com/a.png?token=abc&w=512"),
    ).toBe(true);
  });

  it("フラグメントが付いていても読む", () => {
    expect(looksLikeImageUrl("https://cdn.example.com/a.png#x")).toBe(true);
  });
});

describe("取りに行かないもの", () => {
  /** これが直したかったところ。 */
  it("クエリの末尾が拡張子なだけのページ", () => {
    expect(looksLikeImageUrl("https://example.com/page?ref=photo.png")).toBe(
      false,
    );
    expect(looksLikeImageUrl("https://example.com/?next=/a.jpg")).toBe(false);
  });

  it("拡張子が無いもの", () => {
    expect(looksLikeImageUrl("https://example.com/article")).toBe(false);
  });

  it("似ているが違う拡張子", () => {
    expect(looksLikeImageUrl("https://example.com/a.pngx")).toBe(false);
    expect(looksLikeImageUrl("https://example.com/a.svg")).toBe(false);
  });

  it("URLとして読めないもの", () => {
    expect(looksLikeImageUrl("これはURLではない.png")).toBe(false);
    expect(looksLikeImageUrl("")).toBe(false);
  });
});
