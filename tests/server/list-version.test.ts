import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshSqliteD1, type SqliteD1 } from "./helpers/sqlite-d1";
import type { UnreadResponse } from "../../app/lib/api-types";

/**
 * 「一覧が動いた」番号（listVersion）を、本物の db.server と本物の
 * SQLite で確かめる。
 *
 * サイドバーは5秒ごとの見張りで `MAX(updated_at)` を見て、動いたときだけ
 * 一覧を取り直す。タイトル・ピン・お気に入り・フォルダの変更と削除は
 * updated_at を動かさない——とくに新しい会話の自動タイトルは応答の確定
 * より後に書かれるので、付いた名前がサイドバーに一度も出なかった。
 * これらの書き込みは番号を進め、見張りは番号でも取り直す。
 *
 * 番号を進める文は書き込みの本体と同じ batch に入れる。別に投げると
 * 書き込みのたびにサブリクエストが1つ増える。
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

const dbs = await import("../../app/lib/db.server");
const unread = await import("../../app/routes/api.conversations.unread");

let d1: SqliteD1;

beforeEach(() => {
  d1 = freshSqliteD1();
  box.d1 = d1.binding;
  const add = d1.db.prepare(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, 1, ?)",
  );
  add.run("c1", "一つ目", 10);
  add.run("c2", "二つ目", 20);
});

/** サイドバーの見張りが受け取るもの（本物のルートを通す）。 */
async function flags(): Promise<UnreadResponse> {
  const res = await unread.loader();
  return (await res.json()) as UnreadResponse;
}

/**
 * その書き込みで番号が1つ進み、時刻は動かず、往復は1回で済むこと。
 */
async function expectBump(write: () => Promise<unknown>) {
  const before = await flags();
  const trips = d1.roundTrips;
  await write();
  const writeTrips = d1.roundTrips - trips;
  const after = await flags();
  expect(after.listVersion).toBe(before.listVersion + 1);
  // 時刻だけでは気づけない書き込みである（ここが動くなら番号は要らない）
  expect(after.latest).toBe(before.latest);
  return writeTrips;
}

describe("一覧の番号", () => {
  it("まだ何も変えていなければ 0、時刻は最大値", async () => {
    expect(await flags()).toMatchObject({ latest: 20, listVersion: 0 });
  });

  it("見張り1回の往復は増えない（1つの batch のまま）", async () => {
    const trips = d1.roundTrips;
    await flags();
    expect(d1.roundTrips - trips).toBe(1);
  });

  it("自動タイトル（名付け）で進む。書き込みは1往復のまま", async () => {
    const trips = await expectBump(() =>
      dbs.updateConversationTitle("c1", "付いた名前"),
    );
    expect(trips).toBe(1);
    const row = d1.db
      .prepare("SELECT title FROM conversations WHERE id = 'c1'")
      .get() as { title: string };
    expect(row.title).toBe("付いた名前");
  });

  it("サイドバーでの変更（名前・ピン・お気に入り・フォルダ）で進む", async () => {
    expect(
      await expectBump(() => dbs.updateConversationMeta("c1", { title: "改名" })),
    ).toBe(1);
    await expectBump(() => dbs.updateConversationMeta("c1", { pinned: true }));
    await expectBump(() => dbs.updateConversationMeta("c1", { favorite: true }));
    const folder = await dbs.createFolder("フォルダ");
    await expectBump(() =>
      dbs.updateConversationMeta("c2", { folderId: folder.id }),
    );
  });

  it("何も変えない呼び出しでは進めない", async () => {
    const before = await flags();
    await dbs.updateConversationMeta("c1", {});
    expect((await flags()).listVersion).toBe(before.listVersion);
  });

  it("会話を消すと進む（時刻の最大値はむしろ下がる）", async () => {
    const before = await flags();
    await dbs.deleteConversation("c2");
    const after = await flags();
    expect(after.listVersion).toBe(before.listVersion + 1);
    expect(after.latest).toBe(10);
  });

  it("フォルダの作成・変更・削除で進む", async () => {
    let id = "";
    await expectBump(async () => {
      id = (await dbs.createFolder("フォルダ")).id;
    });
    await expectBump(() => dbs.updateFolder(id, { name: "改名" }));
    await expectBump(() => dbs.deleteFolder(id));
  });

  it("ピン留めの並べ替えで進む", async () => {
    await dbs.updateConversationMeta("c1", { pinned: true });
    await dbs.updateConversationMeta("c2", { pinned: true });
    // 一覧の並び（更新の新しい順）で c2 → c1。c1 を上へ
    await expectBump(() => dbs.movePinnedItem("conversation", "c1", "up"));
    const order = d1.db
      .prepare("SELECT id FROM conversations ORDER BY sort_order")
      .all() as { id: string }[];
    expect(order.map((r) => r.id)).toEqual(["c1", "c2"]);
  });

  it("フォルダの変更は、無いフォルダなら失敗として返す（印とは別に）", async () => {
    expect(await dbs.updateFolder("無いフォルダ", { name: "x" })).toBe(false);
    const f = await dbs.createFolder("ある");
    expect(await dbs.updateFolder(f.id, { name: "y" })).toBe(true);
  });
});
