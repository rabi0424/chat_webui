import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, makeD1 } from "../stubs/d1-sqlite";

/**
 * 添付のアップロード（画像・PDF）。
 *
 * ここを通ったものは、そのままの型で配信され（/api/files/:id）、モデルへも
 * その型で渡る。申告だけを信じると「PDF のふりをした HTML」が PDF として
 * 置かれる。逆に申告が空の PDF（OS に拡張子の登録が無い環境）を弾くと、
 * 入力欄では添えられたように見えたのに、送る前に失敗する。
 *
 * D1 は node:sqlite（流れる SQL は本番のもの）、R2 は置いたものを覚える
 * 入れ物。
 */
const box = vi.hoisted(() => ({
  d1: null as unknown,
  /** R2 に置かれたもの（キーと型）。 */
  puts: [] as { key: string; type: string | undefined }[],
}));

vi.mock("cloudflare:workers", () => ({
  env: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "DB") return box.d1;
        if (prop === "FILES") {
          return {
            async put(
              key: string,
              _body: unknown,
              opts?: { httpMetadata?: { contentType?: string } },
            ) {
              box.puts.push({ key, type: opts?.httpMetadata?.contentType });
            },
            async delete() {},
          };
        }
        throw new Error(`env.${String(prop)} はこのテストでは用意していません`);
      },
    },
  ),
  DurableObject: class {},
}));

const { action } = await import("../../app/routes/api.uploads");

let sqlite: DatabaseSync;
beforeEach(() => {
  sqlite = freshDb();
  box.d1 = makeD1(sqlite, () => ({ roundTrips: 0, statements: [] }));
  box.puts = [];
});

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
const HTML = new TextEncoder().encode("<html><script>alert(1)</script>");

async function upload(file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await action({
    request: new Request("https://example.test/api/uploads", {
      method: "POST",
      body: form,
    }),
    params: {},
    // 掃除は waitUntil に預けるだけ（ここでは走らせない）
    context: { get: () => ({ ctx: { waitUntil: () => {} } }) },
  } as never);
  return { res, body: (await res.json()) as Record<string, unknown> };
}

/** 置かれた添付の行の型。 */
function storedType(id: unknown): string | undefined {
  const row = sqlite
    .prepare("SELECT mime_type FROM attachments WHERE id = ?")
    .get(String(id)) as { mime_type: string } | undefined;
  return row?.mime_type;
}

describe("PDF のアップロード", () => {
  it("PDF は PDF として置く", async () => {
    const { res, body } = await upload(
      new File([PDF], "資料.pdf", { type: "application/pdf" }),
    );
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ mimeType: "application/pdf", name: "資料.pdf" });
    expect(storedType(body.id)).toBe("application/pdf");
    expect(box.puts).toEqual([
      { key: expect.stringMatching(/^attachments\//), type: "application/pdf" },
    ]);
  });

  it("型が空の .pdf は、拡張子で補って中身で確かめる", async () => {
    const { res, body } = await upload(new File([PDF], "scan.pdf", { type: "" }));
    expect(res.status).toBe(200);
    expect(storedType(body.id)).toBe("application/pdf");
  });

  /** これが防ぎたかったところ。 */
  it("PDF のふりをした HTML は置かない", async () => {
    for (const file of [
      new File([HTML], "x.pdf", { type: "application/pdf" }),
      new File([HTML], "x.pdf", { type: "" }),
    ]) {
      const { res, body } = await upload(file);
      expect(res.status).toBe(415);
      expect(body.error).toBe("PDF として読めないファイルです");
    }
    expect(box.puts).toEqual([]);
  });

  it("型が空でも .pdf でなければ補わない", async () => {
    const { res } = await upload(new File([PDF], "notes", { type: "" }));
    expect(res.status).toBe(415);
    expect(box.puts).toEqual([]);
  });

  it("画像は今までどおり置ける", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    const { res, body } = await upload(new File([png], "a.png", { type: "image/png" }));
    expect(res.status).toBe(200);
    expect(storedType(body.id)).toBe("image/png");
  });
});
