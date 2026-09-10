import { describe, expect, it } from "vitest";

/**
 * 縮小版の受け口。ここを通ったものはそのまま画像として配信されるので、
 * 申告（Content-Type）ではなく先頭バイトで形式を確かめ、大きさも
 * 切る。どの検査もストレージに触る前に返る——触ってしまえば、差し替えた
 * env の Proxy がその場で投げる。
 */
const { action } = await import("../../app/routes/api.files.$id.thumb");

const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script>");

function post(body: BodyInit, type: string, length?: number) {
  const headers: Record<string, string> = { "content-type": type };
  if (length != null) headers["content-length"] = String(length);
  return action({
    request: new Request("https://example.test/api/files/a1/thumb", {
      method: "POST",
      headers,
      body,
    }),
    params: { id: "a1" },
    context: {} as never,
  } as never);
}

describe("縮小版の受け口", () => {
  it("PNG は受けない（縮小版としては大きすぎる形式）", async () => {
    const res = await post(new Uint8Array([0x89, 0x50]), "image/png");
    expect(res.status).toBe(415);
  });

  it("申告が WebP でも中身が違えば受けない", async () => {
    const res = await post(HTML, "image/webp");
    expect(res.status).toBe(415);
  });

  it("大きすぎれば受けない（申告で分かるなら読む前に）", async () => {
    const res = await post(WEBP, "image/webp", 10 * 1024 * 1024);
    expect(res.status).toBe(413);
  });

  it("空は受けない", async () => {
    const res = await post(new Uint8Array(0), "image/webp");
    expect(res.status).toBe(413);
  });
});
