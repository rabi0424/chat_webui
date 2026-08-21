import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  generatedImagesSql,
  statementsOf,
} from "../app/lib/schema";

/**
 * スキーマを本物の SQLite に流す。
 *
 * D1 は SQLite なので、構文や索引の間違いはここで捕まえられる。捕まえ
 * られないと、壊れたマイグレーションがそのままデプロイされ、
 * schemaReady が投げてアプリ全体が起動しなくなる（読み書きのすべてが
 * この初期化を通るため）。
 */
function migrate(db: DatabaseSync, upTo = MIGRATIONS.length): void {
  // D1 は外部キーを効かせる。既定では off なので、揃えてから流す
  // （台帳に ON DELETE が付いたら気づけるように）
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  for (const version of MIGRATIONS.slice(0, upTo)) {
    for (const statement of statementsOf(version)) {
      try {
        db.exec(statement);
      } catch (e) {
        // ALTER TABLE ADD COLUMN には IF NOT EXISTS が無いので、
        // 二重適用のエラーだけは本番と同じく読み飛ばす
        if (!/duplicate column name/i.test((e as Error).message)) throw e;
      }
    }
  }
}

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
});

describe("マイグレーション", () => {
  it("最初から最後まで流せる", () => {
    expect(() => migrate(db)).not.toThrow();
  });

  it("途中まで適用された状態から流し直せる", () => {
    // 版の途中で落ちて版番号を記録できなかった場合と、複数の isolate が
    // 同時に初回アクセスした場合の両方がこの形になる
    migrate(db, MIGRATIONS.length - 1);
    expect(() => migrate(db)).not.toThrow();
  });

  it("何度流しても通る", () => {
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
  });
});

describe("使用量の台帳", () => {
  beforeEach(() => migrate(db));

  const addMessage = (id: string, conv: string, model: string) =>
    db
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, content, model_id, created_at) VALUES (?, ?, 'assistant', '', ?, 1)",
      )
      .run(id, conv, model);

  /** 本番と同じ INSERT ... SELECT で載せる。 */
  const record = (
    eventId: string,
    messageId: string,
    cost: number | null,
    points: number | null,
  ) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO usage_events
           (id, at, kind, provider, model_id, cost_usd, points,
            prompt_tokens, completion_tokens, conversation_id, message_id)
         SELECT ?, ?, 'chat',
                CASE WHEN model_id LIKE 'poe:%' THEN 'poe' ELSE 'openrouter' END,
                model_id, ?, ?, NULL, NULL, conversation_id, id
           FROM messages WHERE id = ?`,
      )
      .run(eventId, 1000, cost, points, messageId);

  const totals = () =>
    db
      .prepare(
        `SELECT
           COALESCE(SUM(cost_usd), 0) AS cost_usd,
           COALESCE(SUM(points), 0) AS points,
           COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN points ELSE 0 END), 0)
             AS points_without_cost,
           COUNT(*) AS events
         FROM usage_events WHERE at >= ?`,
      )
      .get(0) as Record<string, number>;

  it("応答の使用量を載せると、モデルと会話が引き継がれる", () => {
    addMessage("m1", "c1", "openai/gpt-4o");
    record("e1", "m1", 0.5, null);
    const row = db
      .prepare("SELECT * FROM usage_events WHERE id = 'e1'")
      .get() as Record<string, unknown>;
    expect(row.model_id).toBe("openai/gpt-4o");
    expect(row.conversation_id).toBe("c1");
    expect(row.provider).toBe("openrouter");
  });

  it("Poe のモデルは provider が poe になる", () => {
    addMessage("m1", "c1", "poe:Claude-Sonnet");
    record("e1", "m1", null, 300);
    const row = db
      .prepare("SELECT provider FROM usage_events WHERE id = 'e1'")
      .get() as { provider: string };
    expect(row.provider).toBe("poe");
  });

  it("同じ応答を二度確定しても二重に数えない", () => {
    addMessage("m1", "c1", "openai/gpt-4o");
    record("e1", "m1", 0.5, null);
    record("e2", "m1", 0.5, null); // 別のイベントIDでも message_id が同じ
    expect(totals().events).toBe(1);
    expect(totals().cost_usd).toBeCloseTo(0.5);
  });

  /**
   * この台帳を messages と別に持つ理由そのもの。
   * 消して減るなら、会話を消すだけで上限が緩む。
   */
  it("メッセージを消しても記録は残る", () => {
    addMessage("m1", "c1", "openai/gpt-4o");
    record("e1", "m1", 0.5, null);
    db.prepare("DELETE FROM messages WHERE id = 'm1'").run();
    expect(totals().events).toBe(1);
    expect(totals().cost_usd).toBeCloseTo(0.5);
  });

  it("会話ごと消しても記録は残る", () => {
    addMessage("m1", "c1", "openai/gpt-4o");
    addMessage("m2", "c1", "openai/gpt-4o");
    record("e1", "m1", 0.5, null);
    record("e2", "m2", 0.25, null);
    db.prepare("DELETE FROM messages WHERE conversation_id = 'c1'").run();
    expect(totals().events).toBe(2);
    expect(totals().cost_usd).toBeCloseTo(0.75);
  });

  it("額の取れなかったポイントだけを別に数えられる", () => {
    addMessage("m1", "c1", "poe:A");
    addMessage("m2", "c1", "poe:B");
    record("e1", "m1", 0.1, 200); // 額が取れた
    record("e2", "m2", null, 300); // 取れなかった
    const t = totals();
    expect(t.points).toBe(500);
    expect(t.points_without_cost).toBe(300);
  });

  it("メッセージに紐づかない支出も載る（タイトル生成）", () => {
    db.prepare(
      `INSERT INTO usage_events
         (id, at, kind, provider, model_id, cost_usd, points,
          prompt_tokens, completion_tokens, conversation_id, message_id)
       VALUES ('t1', 1000, 'title', 'openrouter', 'openai/gpt-4o-mini',
               0.0001, NULL, 10, 5, NULL, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO usage_events
         (id, at, kind, provider, model_id, cost_usd, points,
          prompt_tokens, completion_tokens, conversation_id, message_id)
       VALUES ('t2', 1000, 'title', 'openrouter', 'openai/gpt-4o-mini',
               0.0001, NULL, 10, 5, NULL, NULL)`,
    ).run();
    // message_id が NULL のものは一意制約の対象外（部分索引）
    expect(totals().events).toBe(2);
  });

  it("期間で切れる", () => {
    db.prepare(
      "INSERT INTO usage_events (id, at, kind, provider, cost_usd) VALUES ('a', 100, 'chat', 'openrouter', 1)",
    ).run();
    db.prepare(
      "INSERT INTO usage_events (id, at, kind, provider, cost_usd) VALUES ('b', 300, 'chat', 'openrouter', 2)",
    ).run();
    const since = (t: number) =>
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage_events WHERE at >= ?",
          )
          .get(t) as { c: number }
      ).c;
    expect(since(0)).toBeCloseTo(3);
    expect(since(200)).toBeCloseTo(2);
    expect(since(400)).toBeCloseTo(0);
  });
});

/**
 * 画像一覧の「続きを読む」位置。
 *
 * フォークで実体（R2のキー）を共有する画像は、添付の行が複数ある。
 * 一覧はキーでまとめて1件として出すが、続きを読む位置を**まとめる前**の
 * 1行ずつに効かせていたため、1ページ目に新しいほうの行で出た画像が、
 * 2ページ目では古いほうの行で**もう一度出て**いた。
 */
describe("画像一覧のページ送り", () => {
  beforeEach(() => migrate(db));

  /** 同じ実体を指す添付行。フォークすると増える。 */
  const addImage = (id: string, key: string, at: number) =>
    db
      .prepare(
        `INSERT INTO attachments (id, message_id, conversation_id, r2_key,
           mime_type, name, size, kind, favorite, prompt, created_at)
         VALUES (?, NULL, NULL, ?, 'image/png', NULL, 1, 'generated', 0, NULL, ?)`,
      )
      .run(id, key, at);

  /** 本番と同じSQL（書き写さない。片方だけ直したときに気づけなくなる）。 */
  const page = (before: number, limit = 2) =>
    db.prepare(generatedImagesSql([])).all(before, limit) as {
      id: string;
      created_at: number;
    }[];

  it("同じ実体の画像は1件にまとまる", () => {
    addImage("x1", "shared", 100);
    addImage("x2", "shared", 200);
    expect(page(Number.MAX_SAFE_INTEGER, 10)).toHaveLength(1);
  });

  /** これが直したかったところ。 */
  it("2ページ目に同じ画像が再登場しない", () => {
    // 共有された画像（行が2つ）と、ふつうの画像2つ
    addImage("s1", "shared", 100);
    addImage("s2", "shared", 300);
    addImage("a1", "alone-a", 200);
    addImage("b1", "alone-b", 50);

    const first = page(Number.MAX_SAFE_INTEGER, 2);
    expect(first.map((r) => r.created_at)).toEqual([300, 200]);

    const second = page(first[first.length - 1].created_at, 2);
    // 共有画像が 100 の行で戻ってきてはいけない
    expect(second.map((r) => r.created_at)).toEqual([50]);
  });

  it("全ページを繋げると、実体の数と一致する", () => {
    addImage("s1", "shared", 100);
    addImage("s2", "shared", 300);
    addImage("a1", "alone-a", 200);
    addImage("b1", "alone-b", 50);

    const seen: number[] = [];
    let cursor = Number.MAX_SAFE_INTEGER;
    for (let guard = 0; guard < 10; guard++) {
      const rows = page(cursor, 2);
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.created_at));
      cursor = rows[rows.length - 1].created_at;
    }
    expect(seen).toEqual([300, 200, 50]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("まとめる前で切ると、重複する（以前の作り）", () => {
    addImage("s1", "shared", 100);
    addImage("s2", "shared", 300);
    addImage("a1", "alone-a", 200);

    const oldPage = (before: number, limit = 2) =>
      db
        .prepare(
          `SELECT MAX(a.created_at) AS created_at
             FROM attachments a
            WHERE a.kind = 'generated' AND a.created_at < ?
            GROUP BY a.r2_key
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(before, limit) as { created_at: number }[];

    const first = oldPage(Number.MAX_SAFE_INTEGER, 2);
    const second = oldPage(first[first.length - 1].created_at, 2);
    // 共有画像が古いほうの行で戻ってくる
    expect(second.map((r) => r.created_at)).toContain(100);
  });
});
