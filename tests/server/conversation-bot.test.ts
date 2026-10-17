import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, makeD1, type D1Trace } from "../stubs/d1-sqlite";

/**
 * 会話の担当ボットの差し替え（PATCH の botId）を、本物の db.server と
 * 本物の SQLite で動かす。
 *
 * 見るのは、写しの元をサーバー側でボットの定義から引くこと（バインドの
 * 並びを取り違えると、名前の欄にプロンプトが入る形で黙って壊れる）、
 * 消えたボットでは何も書かないこと、外す指定（null）と「触れない」
 * （省略）を取り違えないこと。最後の取り違えは、モデルを変えただけで
 * 担当のボットが外れる、という形で出る。
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

const route = await import("../../app/routes/api.conversations.$id");

let sqlite: DatabaseSync;
let trace: D1Trace;

const patch = (body: unknown, id = "c1") =>
  route.action({
    request: new Request(`https://x/api/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    params: { id },
  } as never) as Promise<Response>;

const row = (id = "c1") =>
  sqlite.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;

function setDefaultPrompt(prompt: string): void {
  sqlite
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('app_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(JSON.stringify({ defaultSystemPrompt: prompt }));
}

beforeEach(() => {
  sqlite = freshDb();
  trace = { roundTrips: 0, statements: [] };
  box.d1 = makeD1(sqlite, () => trace);
  sqlite
    .prepare(
      `INSERT INTO conversations (id, title, model_id, bot_id, bot_name, bot_icon,
         system_prompt, params_json, created_at, updated_at)
       VALUES ('c1', '題', 'old/model', 'b0', '前の', '🔍', '前のプロンプト',
               '{"temperature":"1.9"}', 1, 1)`,
    )
    .run();
  const bot = sqlite.prepare(
    `INSERT INTO bots (id, name, icon, model_id, system_prompt, params_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
  );
  bot.run("b1", "翻訳", "🌐", "new/model", "あなたは翻訳者です。", '{"temperature":"0.1"}');
  bot.run("b2", "素", "🙂", "plain/model", "   ", null);
});

describe("担当ボットの差し替え", () => {
  it("ボットのいまの定義を写す（モデル・パラメータも）", async () => {
    expect((await patch({ botId: "b1" })).status).toBe(200);
    expect(row()).toMatchObject({
      bot_id: "b1",
      bot_name: "翻訳",
      bot_icon: "🌐",
      system_prompt: "あなたは翻訳者です。",
      params_json: '{"temperature":"0.1"}',
      model_id: "new/model",
    });
  });

  it("空白だけのプロンプトは入れない（作るときと同じ規則）", async () => {
    await patch({ botId: "b2" });
    expect(row()).toMatchObject({
      bot_id: "b2",
      system_prompt: null,
      params_json: null,
    });
  });

  it("null で外すと、プロンプトはアプリ既定へ戻り、モデルとパラメータは残る", async () => {
    setDefaultPrompt("既定のプロンプト");
    expect((await patch({ botId: null })).status).toBe(200);
    expect(row()).toMatchObject({
      bot_id: null,
      bot_name: null,
      bot_icon: null,
      system_prompt: "既定のプロンプト",
      model_id: "old/model",
      params_json: '{"temperature":"1.9"}',
    });
  });

  it("省略したら触れない（モデルだけの変更でボットが外れない）", async () => {
    expect((await patch({ modelId: "other/model" })).status).toBe(200);
    expect(row()).toMatchObject({
      bot_id: "b0",
      bot_name: "前の",
      system_prompt: "前のプロンプト",
      model_id: "other/model",
    });
  });

  it("消えたボットなら 404 で、同じ依頼の他の変更も書かない", async () => {
    const before = row();
    const res = await patch({
      botId: "gone",
      modelId: "other/model",
      params: { temperature: "1" },
    });
    expect(res.status).toBe(404);
    expect(row()).toEqual(before);
  });

  it("モデルも指定されていれば、ボットの写しのあとに書く（指定が勝つ）", async () => {
    await patch({ botId: "b1", modelId: "other/model" });
    expect(row()).toMatchObject({ bot_id: "b1", model_id: "other/model" });
  });

  it("書くのは指定した会話だけ", async () => {
    sqlite
      .prepare(
        "INSERT INTO conversations (id, title, model_id, bot_name, created_at, updated_at) VALUES ('c2', '隣', 'x/model', '隣', 1, 1)",
      )
      .run();
    await patch({ botId: "b1" });
    expect(row("c2")).toMatchObject({ bot_name: "隣", model_id: "x/model" });
  });
});
