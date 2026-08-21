import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 「やった」と返す前に、本当にやったか。
 *
 * 存在しないIDへの更新に 200 を返していた。名前を変えたつもりが変わって
 * いない・印を付けたつもりが付いていない、という結果だけが残る。
 * 呼ぶ側は成功として扱うので、間違いに気づく手立てが無い。
 *
 * 削除は分けて考える。既に消えているものへの DELETE は、目的
 * （そのIDが無い状態）が達成されているので成功でよい。
 */
const db = vi.hoisted(() => ({
  folderUpdated: true,
  imageUpdated: true,
  conversation: { id: "c1" } as unknown,
  calls: [] as string[],
}));

vi.mock("../../app/lib/db.server", () => ({
  updateFolder: async () => {
    db.calls.push("updateFolder");
    return db.folderUpdated;
  },
  deleteFolder: async () => {
    db.calls.push("deleteFolder");
  },
  setImageFavorite: async () => {
    db.calls.push("setImageFavorite");
    return db.imageUpdated;
  },
  getConversation: async () => {
    db.calls.push("getConversation");
    return db.conversation;
  },
  deleteConversation: async () => {},
  markConversationRead: async () => {},
  updateConversationMeta: async () => {},
  updateConversationModel: async () => {},
  updateConversationParams: async () => {},
}));

const folders = await import("../../app/routes/api.folders.$id");
const images = await import("../../app/routes/api.images.$id");
const conversations = await import("../../app/routes/api.conversations.$id");

const call = (
  mod: { action: (a: never) => Promise<Response> },
  method: string,
  body?: unknown,
  id = "x1",
) =>
  mod.action({
    request: new Request("https://x/api", {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params: { id },
  } as never);

beforeEach(() => {
  db.folderUpdated = true;
  db.imageUpdated = true;
  db.conversation = { id: "c1" };
  db.calls = [];
});

describe("フォルダ", () => {
  it("更新できたら 200", async () => {
    expect((await call(folders, "PATCH", { name: "仕事" })).status).toBe(200);
  });

  it("無いものの更新は 404", async () => {
    db.folderUpdated = false;
    expect((await call(folders, "PATCH", { name: "仕事" })).status).toBe(404);
  });

  it("削除は冪等（無くても成功）", async () => {
    expect((await call(folders, "DELETE")).status).toBe(200);
  });

  it("知らないメソッドは 405", async () => {
    expect((await call(folders, "PUT")).status).toBe(405);
  });
});

describe("画像", () => {
  it("更新できたら 200", async () => {
    expect((await call(images, "PATCH", { favorite: true })).status).toBe(200);
  });

  it("無いものの更新は 404", async () => {
    db.imageUpdated = false;
    expect((await call(images, "PATCH", { favorite: true })).status).toBe(404);
  });

  it("favorite が真偽値でなければ 400", async () => {
    expect((await call(images, "PATCH", { favorite: "はい" })).status).toBe(400);
  });
});

describe("会話", () => {
  it("知らないメソッドは、IDが無くても 405", async () => {
    // 存在の確認を先にすると 404 が返り、「そのIDが無い」のか
    // 「その操作ができない」のか区別が付かない
    db.conversation = null;
    const res = await call(conversations, "PUT");
    expect(res.status).toBe(405);
    // 405 と分かった時点で返すので、DBは見に行かない
    expect(db.calls).not.toContain("getConversation");
  });

  it("扱えるメソッドで、IDが無ければ 404", async () => {
    db.conversation = null;
    expect((await call(conversations, "DELETE")).status).toBe(404);
  });

  it("あれば 200", async () => {
    expect((await call(conversations, "DELETE")).status).toBe(200);
  });
});
