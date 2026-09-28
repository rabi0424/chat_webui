import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, makeD1, type D1Trace } from "../stubs/d1-sqlite";
import { monthStartJst } from "../../app/lib/usage";

/**
 * 生成の開始（送信してから実行体へ渡すまで）を、本物の db.server と
 * 本物の SQLite で動かす。
 *
 * 送信から上流へ投げるまでの待ちは、ほぼ D1 との往復の数で決まる。
 * 以前は会話 → 上限（設定・台帳・為替）→ 設定をもう一度 → 繋ぎ先 →
 * 添付 → 書き込み、と6〜7往復が直列に並んでいた。読むものを1つの
 * batch にまとめ、**読む1回＋書く1回**にしたことを見張る。
 *
 * まとめたことで判定の順が崩れていないか（会話が無い → 404、上限 →
 * 402、繋ぎ先が無い → 400、どれも書く前に止まる）も、ここで見る。
 */

const box = vi.hoisted(() => ({
  d1: null as unknown,
  fx: { calls: 0, rate: 150 as number | null },
}));

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

// 為替は外部。叩いたかどうかだけを数える
vi.mock("../../app/lib/fx.server", () => ({
  fetchUsdJpy: async () => {
    box.fx.calls++;
    return box.fx.rate;
  },
}));

let sqlite: DatabaseSync;
let trace: D1Trace;
/** 実行体に渡したジョブ。 */
let started: Record<string, unknown>[];

const route = await import("../../app/routes/api.conversations.$id.generate");

const context = {
  get: () => ({
    env: {
      GENERATOR: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (_url: string, init: RequestInit) => {
            started.push(JSON.parse(String(init.body)) as Record<string, unknown>);
            return new Response("ok", { status: 202 });
          },
        }),
      },
    },
  }),
};

function send(body: Record<string, unknown>, id = "c1") {
  return route.action({
    request: new Request(`https://x/api/conversations/${id}/generate`, {
      method: "POST",
      body: JSON.stringify({
        model: "vendor/chat",
        messages: [{ role: "user", content: "こんにちは" }],
        ...body,
      }),
    }),
    params: { id },
    context,
  } as never) as Promise<Response>;
}

function setSettings(value: Record<string, unknown>): void {
  sqlite
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('app_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(JSON.stringify(value));
}

function storeRate(rate: number): void {
  sqlite
    .prepare("INSERT INTO meta (key, value) VALUES ('usd_jpy', ?)")
    .run(String(rate));
}

/**
 * 今月 cost ドル使ったことにする。時刻は**月の初め**に置く——いまの時刻に
 * 置くと、「今月」ではなく「いまから」で数える取り違えを見逃す。
 * 先月の最後にも同じ額を置き、そちらは数えないことも一緒に見る。
 */
function spend(cost: number): void {
  const add = sqlite.prepare(
    "INSERT INTO usage_events (id, at, kind, provider, model_id, cost_usd) VALUES (?, ?, 'chat', 'openrouter', 'vendor/chat', ?)",
  );
  const start = monthStartJst(Date.now());
  add.run(crypto.randomUUID(), start, cost);
  add.run(crypto.randomUUID(), start - 1, cost);
}

function count(table: string): number {
  return (
    sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

function seed(): void {
  sqlite
    .prepare(
      "INSERT INTO conversations (id, title, created_at, updated_at, current_leaf_message_id) VALUES ('c1', 't', 1, 1, 'a0')",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO conversations (id, title, created_at, updated_at, current_leaf_message_id) VALUES ('c2', 't', 1, 1, NULL)",
    )
    .run();
  const add = sqlite.prepare(
    "INSERT INTO messages (id, conversation_id, parent_id, role, content, status, flushed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  add.run("u0", "c1", null, "user", "前の発言", "done", null, 1);
  add.run("a0", "c1", "u0", "assistant", "前の応答", "done", null, 2);
  add.run("x0", "c2", null, "user", "別の会話", "done", null, 1);
  // アップロード済み（まだどこにも紐づいていない）添付
  const att = sqlite.prepare(
    "INSERT INTO attachments (id, message_id, conversation_id, r2_key, mime_type, name, size, created_at) VALUES (?, NULL, NULL, ?, 'image/png', ?, 1, ?)",
  );
  att.run("img-a", "k/a", "a.png", 10);
  att.run("img-b", "k/b", "b.png", 20);
  att.run("img-c", "k/c", "c.png", 30);
}

beforeEach(async () => {
  sqlite = freshDb();
  trace = { roundTrips: 0, statements: [] };
  box.d1 = makeD1(sqlite, () => trace);
  box.fx = { calls: 0, rate: 150 };
  started = [];
  seed();
  // db.server は isolate ごとに最初の1回だけスキーマを確かめる。その
  // 1往復を数えに入れないよう、先に1回通しておく（存在しない会話で）
  await send({ userContent: "x" }, "nope");
  trace = { roundTrips: 0, statements: [] };
  box.fx.calls = 0;
});

const errorOf = async (res: Response) =>
  ((await res.json()) as { error?: string }).error ?? "";

describe("生成の開始の往復", () => {
  it("繋ぎ先と添付があっても、読む1回と書く1回で実行体へ渡す", async () => {
    setSettings({ monthlyLimitJpy: 10_000 });
    storeRate(150);
    const res = await send({
      parentId: "a0",
      userContent: "この絵を見て",
      userAttachmentIds: ["img-a", "img-b"],
    });
    expect(res.status).toBe(200);
    expect(started).toHaveLength(1);
    expect(trace.roundTrips).toBe(2);
    expect(box.fx.calls).toBe(0);
  });

  it("上限を設けていなくても往復は増えない（為替も取りに行かない）", async () => {
    const res = await send({ parentId: "a0", userContent: "やあ" });
    expect(res.status).toBe(200);
    expect(trace.roundTrips).toBe(2);
    expect(box.fx.calls).toBe(0);
  });

  it("為替が保存されていなければ、そのときだけ取りに行って書いておく", async () => {
    setSettings({ monthlyLimitJpy: 10_000 });
    const res = await send({ userContent: "やあ" });
    expect(res.status).toBe(200);
    expect(box.fx.calls).toBe(1);
    const row = sqlite
      .prepare("SELECT value FROM meta WHERE key = 'usd_jpy'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe("150");
  });
});

describe("まとめて読んでも、判定と書く中身は変わらない", () => {
  it("まとめて読んだ設定を実行体へ渡す", async () => {
    setSettings({ retryWorkerConcurrency: 7, dailyDoSecondsBudget: 1234 });
    await send({ userContent: "やあ" });
    expect(started[0]).toMatchObject({
      workerConcurrency: 7,
      dailyDoSecondsBudget: 1234,
    });
  });

  it("添付は渡した順で新しい発言に紐づく（読み直さずに）", async () => {
    const res = await send({
      parentId: "a0",
      userContent: "3枚",
      userAttachmentIds: ["img-c", "img-a", "img-b"],
    });
    const { userMessageId } = (await res.json()) as { userMessageId: string };
    const linked = sqlite
      .prepare(
        "SELECT id FROM attachments WHERE message_id = ? ORDER BY created_at",
      )
      .all(userMessageId) as { id: string }[];
    expect(linked.map((r) => r.id)).toEqual(["img-c", "img-a", "img-b"]);
    // 添付を読んだ文は1本だけ（beginGeneration が読み直していない）
    expect(
      trace.statements.filter((s) => /FROM attachments WHERE id IN/.test(s.sql)),
    ).toHaveLength(1);
  });

  it("会話が無ければ 404。上限に掛かっていても 404 が先", async () => {
    setSettings({ monthlyLimitJpy: 1 });
    storeRate(150);
    spend(100);
    const before = count("messages");
    const res = await send({ userContent: "やあ" }, "missing");
    expect(res.status).toBe(404);
    expect(count("messages")).toBe(before);
    expect(started).toHaveLength(0);
  });

  it("上限に掛かれば 402 で、何も書かない。繋ぎ先が無くても 402 が先", async () => {
    setSettings({ monthlyLimitJpy: 100 });
    storeRate(150);
    spend(1); // 150円
    const before = count("messages");
    const res = await send({ parentId: "gone", userContent: "やあ" });
    expect(res.status).toBe(402);
    expect(await errorOf(res)).toContain("上限");
    expect(count("messages")).toBe(before);
    expect(started).toHaveLength(0);
  });

  it("上限の手前なら通す（まとめて読んだ台帳の合計で判定している）", async () => {
    setSettings({ monthlyLimitJpy: 200 });
    storeRate(150);
    spend(1); // 今月 150円（先月の 150円は数えない）
    const res = await send({ userContent: "やあ" });
    expect(res.status).toBe(200);
  });

  it("自分で読みに行く判定（リトライ生成の発射ループ）も同じ答えを出す", async () => {
    const { checkMonthlyLimit } = await import("../../app/lib/limit.server");
    setSettings({ monthlyLimitJpy: 100 });
    storeRate(150);
    expect((await checkMonthlyLimit()).blocked).toBe(false);
    spend(1); // 150円
    expect((await checkMonthlyLimit()).blocked).toBe(true);
    // 台帳に載っていない消費も足して判定する
    setSettings({ monthlyLimitJpy: 200 });
    expect(
      (await checkMonthlyLimit(Date.now(), { points: 0, costUsd: 1 })).blocked,
    ).toBe(true);
  });

  it("今月だけ解除していれば、上限を越えていても通す", async () => {
    const d = new Date(Date.now() + 9 * 3600_000);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    setSettings({ monthlyLimitJpy: 100, monthlyLimitOverride: month });
    storeRate(150);
    spend(10);
    const res = await send({ userContent: "やあ" });
    expect(res.status).toBe(200);
  });

  it("繋ぎ先が無ければ 400 で、何も書かない", async () => {
    const before = count("messages");
    const res = await send({ parentId: "gone", userContent: "やあ" });
    expect(res.status).toBe(400);
    expect(count("messages")).toBe(before);
  });

  it("別の会話の発言を繋ぎ先にはできない", async () => {
    const before = count("messages");
    const res = await send({ parentId: "x0", userContent: "やあ" });
    expect(res.status).toBe(400);
    expect(count("messages")).toBe(before);
  });

  it("繋ぎ先が中断されたまま残っていれば、単独で読んだときと同じく確定させる", async () => {
    sqlite
      .prepare(
        "INSERT INTO messages (id, conversation_id, parent_id, role, content, status, flushed_at, created_at) VALUES ('s0', 'c1', 'a0', 'assistant', '途中まで', 'streaming', 1, 3)",
      )
      .run();
    const res = await send({ parentId: "s0", userContent: "続けて" });
    expect(res.status).toBe(200);
    const row = sqlite
      .prepare("SELECT status FROM messages WHERE id = 's0'")
      .get() as { status: string };
    expect(row.status).not.toBe("streaming");
  });
});
