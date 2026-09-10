import { describe, expect, it } from "vitest";
import { halvingSteps, thumbnailSize } from "../app/lib/thumbnail";
import {
  THUMBNAIL_LONG_SIDE_MAX,
  THUMBNAIL_SHORT_SIDE,
} from "../app/lib/constants";

/**
 * 縮小版の大きさ。一覧のマス（最大 400px の正方形・中央を切り出す）に
 * 対して短い辺が足りないと、マスいっぱいに引き伸ばされて粗くなる。
 * 逆に長い辺を切らないと、横長の画像で縮小版が原寸に近い大きさになる。
 */
describe("縮小版の大きさ", () => {
  it("短い辺を 512px にする（正方形）", () => {
    expect(thumbnailSize(1024, 1024)).toEqual({ width: 512, height: 512 });
  });

  it("横長は短い辺（高さ）を 512px に", () => {
    expect(thumbnailSize(1536, 1024)).toEqual({ width: 768, height: 512 });
  });

  it("極端に横長なら、長い辺を 1536px で切る", () => {
    const r = thumbnailSize(8192, 2048);
    expect(r.width).toBe(THUMBNAIL_LONG_SIDE_MAX);
    expect(r.height).toBe(384);
    expect(Math.min(r.width, r.height)).toBeLessThan(THUMBNAIL_SHORT_SIDE);
  });

  it("元が小さければ拡大しない", () => {
    expect(thumbnailSize(300, 200)).toEqual({ width: 300, height: 200 });
  });
});

/**
 * 段階縮小。一度に 1/4 以下へ縮めるとブラウザの補間が画素を飛ばして
 * ざらつくので、半分ずつ刻む。最後の1段は 1/2〜1 倍の縮小になる。
 */
describe("段階縮小", () => {
  it("4096 → 512 は 2048・1024 を経る（最後の 1024 → 512 は本描き）", () => {
    expect(halvingSteps(4096, 512)).toEqual([2048, 1024]);
  });

  it("2倍以内なら段を踏まない", () => {
    expect(halvingSteps(1024, 512)).toEqual([]);
    expect(halvingSteps(1000, 512)).toEqual([]);
  });

  it("2倍を少しでも超えれば1段挟む", () => {
    expect(halvingSteps(1100, 512)).toEqual([550]);
  });
});
