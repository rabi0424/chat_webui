import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, makeD1 } from "../stubs/d1-sqlite";

/**
 * PDF の頁数（OCR の見積もり）が、添付の行の行き来で落ちないこと。
 *
 * 頁数はアップロードのときに端末が数えて1度だけ申告する。あとから数え
 * 直す手立ては無いので、行を作る・複製する（分岐・編集して再送信）の
 * どこかで写し忘れると、その先の会話では見積もりが「頁数が分からない」
 * になる——画面にエラーは出ず、額が出なくなるだけ。
 *
 * D1 は node:sqlite（流れる SQL は本番のもの。schema.ts の
 * ATTACHMENT_INSERT_SQL / ATTACHMENT_COPY_SQL）。
 */
const box = vi.hoisted(() => ({ d1: null as unknown }));

vi.mock("cloudflare:workers", () => ({
  env: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "DB") return box.d1;
        throw new Error(`env.${String(prop)} はこのテストでは用意していません`);
      },
    },
  ),
  DurableObject: class {},
}));

const { createAttachment, forkConversation, getAttachments } = await import(
  "../../app/lib/db.server"
);
const { toUiMessage } = await import("../../app/lib/serialize.server");

let sqlite: DatabaseSync;
beforeEach(() => {
  sqlite = freshDb();
  box.d1 = makeD1(sqlite, () => ({ roundTrips: 0, statements: [] }));
});

describe("PDF の頁数", () => {
  it("アップロードで置いた頁数を、行から読み戻せる", async () => {
    const row = await createAttachment({
      r2Key: "k/p1",
      mimeType: "application/pdf",
      name: "資料.pdf",
      size: 10,
      pages: 7,
    });
    expect(row.pages).toBe(7);
    const [read] = await getAttachments([row.id]);
    expect(read.pages).toBe(7);
  });

  it("分岐で添付を複製しても、頁数を写す", async () => {
    sqlite.exec(`
      INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 't', 1, 1);
      INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at)
        VALUES ('u1', 'c1', NULL, 'user', '読んで', 1);
    `);
    const pdf = await createAttachment({
      r2Key: "k/p1",
      mimeType: "application/pdf",
      name: "資料.pdf",
      size: 10,
      pages: 7,
    });
    sqlite
      .prepare("UPDATE attachments SET message_id = 'u1', conversation_id = 'c1' WHERE id = ?")
      .run(pdf.id);
    const conv = sqlite.prepare("SELECT * FROM conversations WHERE id = 'c1'").get();

    const forked = await forkConversation(conv as never, "u1");
    expect(forked).toBeTruthy();
    const copies = sqlite
      .prepare("SELECT id, pages, mime_type FROM attachments WHERE conversation_id = ?")
      .all(forked!) as { id: string; pages: number | null; mime_type: string }[];
    // 複製は新しい行（元の行を奪っていない）で、頁数も型も写っている
    expect(copies).toHaveLength(1);
    expect(copies[0].id).not.toBe(pdf.id);
    expect(copies[0]).toMatchObject({ pages: 7, mime_type: "application/pdf" });
  });

  it("画面へ渡す形にも頁数が載る（無ければ載せない）", () => {
    const base = {
      id: "u1",
      role: "user",
      content: "",
      reasoning: null,
      citations_json: null,
      status: "done",
      error: null,
      usage_json: null,
      model_id: null,
      created_at: 1,
      flushed_at: null,
      context_boundary: 0,
      sibling_ids: ["u1"],
      sibling_index: 0,
    };
    const att = (pages: number | null) => ({
      id: "a1",
      mime_type: "application/pdf",
      name: "x.pdf",
      size: 1,
      kind: "upload",
      thumb_at: null,
      pages,
    });
    expect(
      toUiMessage({ ...base, attachments: [att(7)] } as never).attachments?.[0],
    ).toMatchObject({ pages: 7 });
    expect(
      toUiMessage({ ...base, attachments: [att(null)] } as never).attachments?.[0],
    ).not.toHaveProperty("pages");
  });
});
