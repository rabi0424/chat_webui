import { describe, expect, it } from "vitest";
import { readImageSize } from "../app/lib/image-size";
import {
  GIF_40x24,
  JPEG_40x24,
  PNG_24x40,
  PNG_40x24,
  WEBP_VP8_40x24,
  WEBP_VP8L_40x24,
  WEBP_VP8X_40x24,
} from "./fixtures/images";

/**
 * 画像の縦横の読み取り。
 *
 * ここが外すと、出力の大きさが**静かに**変わる。倍率を掛ける相手が
 * 違うだけなので、上流はエラーを返さず絵も出る——出来上がりの画素数を
 * 数えるまで誰も気づけない。縦横を取り違えた場合はもっと分かりにくく、
 * 「縦長を頼んだのに横長で返ってきた」という形でだけ出る。
 *
 * そのため、試すのは**本物の符号化器が吐いたバイト列**（tests/fixtures）で、
 * 縦長と横長を両方置いてある。手で組んだヘッダで試すと、自分の思い込みを
 * 自分で確かめるだけになる。
 */
describe("readImageSize", () => {
  it("PNG", () => {
    expect(readImageSize(PNG_40x24)).toEqual({ width: 40, height: 24 });
  });

  /** 縦横を入れ替えて読んでいれば、ここで 40x24 になる。 */
  it("PNG（縦長）", () => {
    expect(readImageSize(PNG_24x40)).toEqual({ width: 24, height: 40 });
  });

  /** JPEG の SOF は**高さが先**。取り違えると縦長・横長が反転する。 */
  it("JPEG", () => {
    expect(readImageSize(JPEG_40x24)).toEqual({ width: 40, height: 24 });
  });

  it("GIF", () => {
    expect(readImageSize(GIF_40x24)).toEqual({ width: 40, height: 24 });
  });

  /*
   * WebP は中身が3通りあり、大きさの置き場も詰め方も違う。添付は縮小して
   * WebP へ焼き直しているので、ここを1つでも落とすと「入力画像に合わせる」が
   * 手元の写真で効かない、という形で出る。
   */
  it("WebP（非可逆 VP8）", () => {
    expect(readImageSize(WEBP_VP8_40x24)).toEqual({ width: 40, height: 24 });
  });

  it("WebP（可逆 VP8L）", () => {
    expect(readImageSize(WEBP_VP8L_40x24)).toEqual({ width: 40, height: 24 });
  });

  it("WebP（拡張 VP8X。透過やICCが付くとこの形になる）", () => {
    expect(readImageSize(WEBP_VP8X_40x24)).toEqual({ width: 40, height: 24 });
  });
});

/** 先頭に大きな区間（EXIF など）を挟んでも、SOF まで辿り着けるか。 */
describe("JPEG の区間を飛ばす", () => {
  /** 本物の JPEG の SOI 直後へ、長さ付きの APP1 区間を差し込む。 */
  function withApp1(source: ArrayBuffer, payloadBytes: number): ArrayBuffer {
    const src = new Uint8Array(source);
    const length = payloadBytes + 2;
    const segment = new Uint8Array(payloadBytes + 4);
    segment[0] = 0xff;
    segment[1] = 0xe1;
    segment[2] = (length >> 8) & 0xff;
    segment[3] = length & 0xff;
    segment.fill(0x20, 4);
    const out = new Uint8Array(src.length + segment.length);
    out.set(src.slice(0, 2), 0);
    out.set(segment, 2);
    out.set(src.slice(2), 2 + segment.length);
    return out.buffer;
  }

  it("EXIF を挟んでも同じ大きさを読む", () => {
    // 写真の EXIF は数十KBになる。「先頭の数百バイトを見れば分かる」と
    // 決め打つと、カメラで撮った写真だけ読めないことになる
    expect(readImageSize(withApp1(JPEG_40x24, 40_000))).toEqual({
      width: 40,
      height: 24,
    });
  });

  it("区間の長さが嘘でも、無限に回らず諦める", () => {
    const b = new Uint8Array(JPEG_40x24.byteLength);
    b.set(new Uint8Array(JPEG_40x24));
    // 長さ 0（ありえない値）。長さを足して進む作りだと、ここで止まる
    b[2] = 0xff;
    b[3] = 0xe1;
    b[4] = 0x00;
    b[5] = 0x00;
    expect(readImageSize(b.buffer)).toBeNull();
  });
});

describe("読めないものは推測しない", () => {
  const bytes = (...b: number[]) => new Uint8Array(b).buffer;

  it("画像でないもの", () => {
    expect(readImageSize(new TextEncoder().encode("<html>").buffer)).toBeNull();
    expect(readImageSize(bytes())).toBeNull();
  });

  it("途中で切れた PNG", () => {
    const head = new Uint8Array(PNG_40x24.slice(0, 18));
    expect(readImageSize(head.buffer)).toBeNull();
  });

  /**
   * 先頭の8バイトさえ合っていれば「PNG として保存され、PNG として
   * 配信される」（アップロードの検査はマジックナンバーしか見ない）。
   * その先を確かめずに数を読むと、**画像ですらないものの中身を縦横として
   * 上流へ送る**ことになる。
   */
  it("PNG の印はあるが、先頭のチャンクが IHDR でない", () => {
    const b = new Uint8Array(PNG_40x24.slice(0));
    b.set(new TextEncoder().encode("junk"), 12);
    expect(readImageSize(b.buffer)).toBeNull();
  });

  it("形式は WebP だが中身の種類を知らない", () => {
    const b = new Uint8Array(WEBP_VP8_40x24.slice(0));
    b[12] = 0x58; // "VP8 " → "XP8 "
    expect(readImageSize(b.buffer)).toBeNull();
  });

  /** 0 を大きさとして返すと、倍率を掛けても 0 のまま上流へ送ってしまう。 */
  it("縦横が 0 の PNG", () => {
    const b = new Uint8Array(PNG_40x24.slice(0));
    b.set([0, 0, 0, 0], 16); // 幅 = 0
    expect(readImageSize(b.buffer)).toBeNull();
  });
});
