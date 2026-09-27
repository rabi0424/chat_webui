import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLUSH_GENERATION_SQL,
  MARK_THUMBNAIL_SQL,
  MIGRATIONS,
  PATH_MESSAGES_SQL,
  REWRITE_MESSAGE_CONTENT_SQL,
  STALE_STREAMING_MS,
  statementsOf,
} from "../../app/lib/schema";
import { formatRetryProgress, type RetryProgress } from "../../app/lib/retry";
import { decodeRunProgress, RUN_PROGRESS_HEADER } from "../../app/lib/polling";

/**
 * /path のルートを、本物の db.server と本物の SQLite で動かす。
 *
 * 「成功するまで生成」の追跡は毎秒ここを叩く。見たいのは3つ:
 *   - 司令役が見出しを打ち直しただけ（毎秒起きる）では 304 になる
 *   - 304 のときは本文を読まない（D1 から積み上がった成功の本文を運ばない）
 *     し、往復は1回で済む
 *   - 画面に出るものが変わったら、必ず 200 で返る
 *
 * 札の作り方（本文を読む側と読まない側）が食い違うと 304 が二度と返らなく
 * なる。画面は壊れず黙って重くなるだけなので、ルートを通して確かめる。
 *
 * D1 の代わりに node:sqlite を薄く包んで渡す。流れる SQL は本番のもの。
 */

const box = vi.hoisted(() => ({
  d1: null as unknown,
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

/** 1回の呼び出しで流れたもの。 */
interface Trace {
  /** D1 への往復（batch は1回、単発の文も1回）。 */
  roundTrips: number;
  sql: string[];
  /** SQLite から返った値（文字列だけ）。本文を読んだかを見る。 */
  values: string[];
}

let sqlite: DatabaseSync;
let trace: Trace;

function makeD1(db: DatabaseSync) {
  const record = (sql: string, rows: Record<string, unknown>[]) => {
    trace.sql.push(sql);
    for (const r of rows) {
      for (const v of Object.values(r)) {
        if (typeof v === "string") trace.values.push(v);
      }
    }
  };
  const statement = (sql: string, args: unknown[] = []) => {
    const exec = () => {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|WITH)/i.test(sql)) {
        const rows = st.all(...(args as never[])) as Record<string, unknown>[];
        record(sql, rows);
        return { results: rows, meta: { changes: 0 } };
      }
      const info = st.run(...(args as never[]));
      record(sql, []);
      return { results: [], meta: { changes: Number(info.changes) } };
    };
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      exec,
      async all() {
        trace.roundTrips++;
        return exec();
      },
      async first() {
        trace.roundTrips++;
        return exec().results[0] ?? null;
      },
      async run() {
        trace.roundTrips++;
        return exec();
      },
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    async batch(list: ReturnType<typeof statement>[]) {
      trace.roundTrips++;
      return list.map((s) => s.exec());
    },
    async exec(sql: string) {
      db.exec(sql);
    },
  };
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  for (const version of MIGRATIONS) {
    for (const s of statementsOf(version)) {
      try {
        db.exec(s);
      } catch (e) {
        if (!/duplicate column name/i.test((e as Error).message)) throw e;
      }
    }
  }
  // 適用済みと記録しておく（db.server は最初の1回だけマイグレーションを流す）
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(MIGRATIONS.length));
  return db;
}

const route = await import("../../app/routes/api.conversations.$id.path");

const progress = (p: Partial<RetryProgress> = {}) =>
  formatRetryProgress({
    target: 3,
    successes: 2,
    attempts: 5,
    maxAttempts: 100,
    refusals: 3,
    emptyResponses: 0,
    transients: 0,
    running: 4,
    slots: 6,
    waitSeconds: 0,
    stopping: false,
    ...p,
  });

/** 積み上がった成功の本文。304 のときにこれが D1 から出てきたら負け。 */
const BODY_1 = "一枚目の成功の本文。".repeat(40);
const BODY_2 = "二枚目の成功の本文。".repeat(40);

function seed(): void {
  const now = Date.now();
  sqlite
    .prepare(
      "INSERT INTO conversations (id, title, created_at, updated_at, current_leaf_message_id) VALUES ('c1', 't', 1, 1, 's2')",
    )
    .run();
  const add = sqlite.prepare(
    "INSERT INTO messages (id, conversation_id, parent_id, role, content, status, flushed_at, created_at) VALUES (?, 'c1', ?, ?, ?, ?, ?, ?)",
  );
  add.run("u1", null, "user", "猫の絵", "done", null, 1);
  add.run("h1", "u1", "assistant", progress(), "streaming", now, 2);
  add.run("s1", "h1", "assistant", BODY_1, "done", 3, 3);
  add.run("s2", "s1", "assistant", BODY_2, "done", 4, 4);
}

async function get(etag?: string | null): Promise<Response> {
  trace = { roundTrips: 0, sql: [], values: [] };
  return (await route.loader({
    request: new Request("https://x/api/conversations/c1/path", {
      headers: etag ? { "If-None-Match": etag } : {},
    }),
    params: { id: "c1" },
  } as never)) as Response;
}

/** 司令役の毎秒の打ち直し（本番と同じ文）。 */
function tick(content: string): void {
  sqlite.prepare(FLUSH_GENERATION_SQL).run(content, null, Date.now(), "h1");
}

beforeEach(() => {
  sqlite = freshDb();
  box.d1 = makeD1(sqlite);
  trace = { roundTrips: 0, sql: [], values: [] };
  seed();
});

describe("パスの札（本物の SQLite で）", () => {
  it("札を持って来なければ、本文ごと1往復で返す", async () => {
    // 最初の1回はスキーマの確認が乗るので、2回目を見る
    await get();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^W\//);
    const body = (await res.json()) as { messages: { id: string }[] };
    expect(body.messages.map((m) => m.id)).toEqual(["u1", "h1", "s1", "s2"]);
    // 会話・メッセージ・添付を直列に読んでいた（3〜4往復）のを1つの batch に
    expect(trace.roundTrips).toBe(1);
  });

  it("何も変わっていなければ 304。本文を読まず、1往復で済む", async () => {
    const etag = (await get()).headers.get("ETag");
    const res = await get(etag);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(trace.roundTrips).toBe(1);
    // 積み上がった成功の本文を D1 から読んでいない
    expect(trace.sql).not.toContain(PATH_MESSAGES_SQL);
    expect(trace.values).not.toContain(BODY_1);
    expect(trace.values).not.toContain(BODY_2);
    // 読んだ本文は見出しの1行だけ（札の側が見出しを見分けるのに要る）
    expect(trace.values).toContain(progress());
  });

  it("司令役が見出しを打ち直しただけなら 304 のまま。進捗はヘッダーで届く", async () => {
    const etag = (await get()).headers.get("ETag");
    // 数字が同じでも書き込み時刻は毎秒動く。以前はこれで札が変わっていた
    tick(progress());
    const same = await get(etag);
    expect(same.status).toBe(304);
    expect(decodeRunProgress(same.headers.get(RUN_PROGRESS_HEADER))).toEqual({
      id: "h1",
      content: progress(),
    });

    // 待ちの本数が動いた。札は変えず、進捗だけを新しくして届ける
    tick(progress({ running: 2, attempts: 7 }));
    const moved = await get(etag);
    expect(moved.status).toBe(304);
    expect(decodeRunProgress(moved.headers.get(RUN_PROGRESS_HEADER))).toEqual({
      id: "h1",
      content: progress({ running: 2, attempts: 7 }),
    });
  });

  it("成功が積まれたら 200", async () => {
    const etag = (await get()).headers.get("ETag");
    sqlite
      .prepare(
        "INSERT INTO messages (id, conversation_id, parent_id, role, content, status, flushed_at, created_at) VALUES ('s3', 'c1', 's2', 'assistant', '三枚目', 'done', 5, 5)",
      )
      .run();
    sqlite
      .prepare("UPDATE conversations SET current_leaf_message_id = 's3' WHERE id = 'c1'")
      .run();
    const res = await get(etag);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { id: string }[] };
    expect(body.messages.map((m) => m.id)).toContain("s3");
    // 札だけを読む1往復と、本文を読む1往復
    expect(trace.roundTrips).toBe(2);
  });

  it("積んだ応答の本文を差し替えたら 200（画像を自前の置き場へ移した。S-7）", async () => {
    const etag = (await get()).headers.get("ETag");
    sqlite.prepare(REWRITE_MESSAGE_CONTENT_SQL).run("![](/api/files/x)", 99, "s1");
    expect((await get(etag)).status).toBe(200);
  });

  it("見出しが確定したら 200（本文が同じでも）", async () => {
    const etag = (await get()).headers.get("ETag");
    sqlite.prepare("UPDATE messages SET status = 'done' WHERE id = 'h1'").run();
    expect((await get(etag)).status).toBe(200);
  });

  it("添付の縮小版ができたら 200", async () => {
    sqlite
      .prepare(
        "INSERT INTO attachments (id, message_id, conversation_id, r2_key, mime_type, size, created_at, kind) VALUES ('f1', 's1', 'c1', 'k1', 'image/png', 1, 3, 'generated')",
      )
      .run();
    const etag = (await get()).headers.get("ETag");
    sqlite.prepare(MARK_THUMBNAIL_SQL).run(10, "f1");
    expect((await get(etag)).status).toBe(200);
  });

  it("区切り線を付けたら 200", async () => {
    const etag = (await get()).headers.get("ETag");
    sqlite.prepare("UPDATE messages SET context_boundary = 1 WHERE id = 's1'").run();
    expect((await get(etag)).status).toBe(200);
  });

  it("兄弟が増えたら 200（ページャが出る）", async () => {
    const etag = (await get()).headers.get("ETag");
    sqlite
      .prepare(
        "INSERT INTO messages (id, conversation_id, parent_id, role, content, status, created_at) VALUES ('s1b', 'c1', 'h1', 'assistant', '別の枝', 'done', 9)",
      )
      .run();
    expect((await get(etag)).status).toBe(200);
  });

  it("見出しが止まっていたら、札が同じでも本文を読んで確定させる", async () => {
    /*
     * 札は見出しの書き込み時刻を見ないので、見出しが止まっても札は同じ。
     * そこで 304 を返すと、中断を確定させる経路（本文を読む側にある）を
     * 誰も通らず、画面は「生成中」のまま永久に追い続ける。
     */
    const etag = (await get()).headers.get("ETag");
    sqlite
      .prepare("UPDATE messages SET flushed_at = ? WHERE id = 'h1'")
      .run(Date.now() - STALE_STREAMING_MS - 1_000);
    const res = await get(etag);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: { id: string; status?: string }[];
    };
    expect(body.messages.find((m) => m.id === "h1")?.status).toBe("error");
  });

  it("会話が消えていたら 404（札を持って来ても）", async () => {
    const etag = (await get()).headers.get("ETag");
    sqlite.prepare("DELETE FROM conversations WHERE id = 'c1'").run();
    expect((await get(etag)).status).toBe(404);
  });
});
