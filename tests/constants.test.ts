import { describe, expect, it } from "vitest";
import {
  ALLOWED_IMAGE_TYPES,
  DEFAULT_MODEL,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TITLE_LENGTH,
  MAX_UPLOAD_BYTES,
  TITLE_MODEL,
} from "../app/lib/constants";
import { isAcceptedImage } from "../app/lib/image";

/**
 * サーバーとクライアントで共有する決まりごと。
 *
 * かつては同じ値がサーバー専用モジュールとクライアント側に別々に
 * 書かれ、「揃えること」をコメントで頼んでいた。片側だけ変えると
 * 検証がすり抜ける（受け付けたのに保存で弾かれる、逆に無検証で通る）
 * ので、1か所から読んでいることを確かめる。
 */
describe("共有の決まりごと", () => {
  it("受け入れる画像の判定が、共有の一覧と一致する", () => {
    for (const type of ALLOWED_IMAGE_TYPES) {
      expect(isAcceptedImage({ type } as File), type).toBe(true);
    }
    for (const type of ["image/svg+xml", "application/pdf", "text/plain", ""]) {
      expect(isAcceptedImage({ type } as File), type).toBe(false);
    }
  });

  it("MIMEに charset などが付いていても判定できる", () => {
    expect(isAcceptedImage({ type: "image/png;charset=binary" } as File)).toBe(true);
    expect(isAcceptedImage({ type: "IMAGE/PNG" } as File)).toBe(true);
  });

  it("上限は現実的な範囲にある", () => {
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBeGreaterThan(0);
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(0);
    expect(MAX_TITLE_LENGTH).toBeGreaterThan(0);
  });

  it("モデルIDが空でない", () => {
    expect(DEFAULT_MODEL).toBeTruthy();
    expect(TITLE_MODEL).toBeTruthy();
  });
});
