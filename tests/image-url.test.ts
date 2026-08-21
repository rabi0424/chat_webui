import { describe, expect, it } from "vitest";
import { isFetchableImageUrl, looksLikeImageUrl } from "../app/lib/image-url";

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

/**
 * 取りに行ってよい宛先か。
 *
 * ここへ来る URL は**モデルが本文に書いたもの**で、こちらが決めた値では
 * ない。上流が細工された応答を返せば、その URL をサーバーが取りに行く
 * ことになる。宛先を選べる取得口を、外から文字列で指定できる形で
 * 開けておく理由は無い。
 */
describe("取りに行ってよい宛先", () => {
  it("ふつうの https は通す", () => {
    expect(isFetchableImageUrl("https://cdn.example.com/a.png")).toBe(true);
  });

  it("http も通す（CDNによっては使う）", () => {
    expect(isFetchableImageUrl("http://cdn.example.com/a.png")).toBe(true);
  });

  it("http/https 以外は断る", () => {
    expect(isFetchableImageUrl("file:///etc/passwd")).toBe(false);
    expect(isFetchableImageUrl("ftp://example.com/a.png")).toBe(false);
    expect(isFetchableImageUrl("blob:https://example.com/x")).toBe(false);
  });

  it("自分自身は断る", () => {
    expect(isFetchableImageUrl("http://localhost/a.png")).toBe(false);
    expect(isFetchableImageUrl("http://127.0.0.1:8080/a.png")).toBe(false);
    expect(isFetchableImageUrl("http://[::1]/a.png")).toBe(false);
    expect(isFetchableImageUrl("http://0.0.0.0/a.png")).toBe(false);
  });

  it("私設アドレスは断る", () => {
    expect(isFetchableImageUrl("http://10.0.0.5/a.png")).toBe(false);
    expect(isFetchableImageUrl("http://192.168.1.1/a.png")).toBe(false);
    expect(isFetchableImageUrl("http://172.16.0.1/a.png")).toBe(false);
    expect(isFetchableImageUrl("http://172.31.255.255/a.png")).toBe(false);
  });

  it("私設に見えて違うものは通す", () => {
    expect(isFetchableImageUrl("http://172.15.0.1/a.png")).toBe(true);
    expect(isFetchableImageUrl("http://172.32.0.1/a.png")).toBe(true);
    expect(isFetchableImageUrl("http://11.0.0.1/a.png")).toBe(true);
  });

  /** クラウドのメタデータが居る場所。 */
  it("リンクローカルは断る", () => {
    expect(isFetchableImageUrl("http://169.254.169.254/latest/meta-data")).toBe(
      false,
    );
    expect(isFetchableImageUrl("http://[fe80::1]/a.png")).toBe(false);
  });

  it("内部向けの名前は断る", () => {
    expect(isFetchableImageUrl("http://db.internal/a.png")).toBe(false);
    expect(isFetchableImageUrl("http://foo.localhost/a.png")).toBe(false);
  });

  it("IPv6 のユニークローカルは断る", () => {
    expect(isFetchableImageUrl("http://[fd00::1]/a.png")).toBe(false);
    expect(isFetchableImageUrl("http://[fc00::1]/a.png")).toBe(false);
  });

  it("URLとして読めないものは断る", () => {
    expect(isFetchableImageUrl("画像です")).toBe(false);
    expect(isFetchableImageUrl("")).toBe(false);
  });
});
