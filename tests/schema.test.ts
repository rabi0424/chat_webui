import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DUE_PENDING_DELETIONS_SQL,
  MIGRATIONS,
  PENDING_DELETION_GRACE_MS,
  QUEUE_PENDING_DELETION_SQL,
  clearPendingDeletionsSql,
  generatedImagesSql,
  statementsOf,
  stillReferencedSql,
  undoGenerationStatements,
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

/**
 * 生成の開始を取り消す。
 *
 * beginGeneration は行を保存してから返る。そのあとで生成の実行を登録
 * できなかった場合、保存だけが残る——ユーザーの発言と、永久に
 * 「生成中」のままの応答が木に積まれる。利用者から見ると失敗したので
 * 送り直すが、そのたびに**同じ発言が増えていく**。
 */
describe("生成の開始の取り消し", () => {
  beforeEach(() => migrate(db));

  const setup = () => {
    db.prepare(
      `INSERT INTO conversations (id, title, model_id, current_leaf_message_id, created_at, updated_at)
       VALUES ('c1', '会話', 'm', 'old-leaf', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, created_at)
       VALUES ('old-leaf', 'c1', NULL, 'assistant', '前の応答', 'done', 1)`,
    ).run();
    // 送信で保存された分
    db.prepare(
      `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, created_at)
       VALUES ('u1', 'c1', 'old-leaf', 'user', 'こんにちは', 'done', 2)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, created_at)
       VALUES ('a1', 'c1', 'u1', 'assistant', '', 'streaming', 3)`,
    ).run();
    db.prepare(
      `INSERT INTO attachments (id, message_id, conversation_id, r2_key, mime_type, name, size, kind, favorite, prompt, created_at)
       VALUES ('att1', 'u1', 'c1', 'k1', 'image/png', NULL, 1, 'upload', 0, NULL, 2)`,
    ).run();
    db.prepare(
      "UPDATE conversations SET current_leaf_message_id = 'a1' WHERE id = 'c1'",
    ).run();
  };

  /** 本番と同じ文（書き写さない。片方だけ直したときに気づけなくなる）。 */
  const undo = () => {
    for (const st of undoGenerationStatements({
      conversationId: "c1",
      userMessageId: "u1",
      assistantMessageId: "a1",
      previousLeafId: "old-leaf",
    })) {
      db.prepare(st.sql).run(...(st.binds as never[]));
    }
  };

  const count = (sql: string, ...b: unknown[]) =>
    (db.prepare(sql).get(...(b as never[])) as { n: number }).n;

  it("保存された2行が消える", () => {
    setup();
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE id IN ('u1','a1')")).toBe(2);
    undo();
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE id IN ('u1','a1')")).toBe(0);
  });

  it("前からあった発言は残る", () => {
    setup();
    undo();
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE id = 'old-leaf'")).toBe(1);
  });

  it("見ていた位置が戻る", () => {
    setup();
    undo();
    const row = db
      .prepare("SELECT current_leaf_message_id AS leaf FROM conversations WHERE id = 'c1'")
      .get() as { leaf: string };
    expect(row.leaf).toBe("old-leaf");
  });

  it("添付は消えず、紐づけだけ外れる", () => {
    setup();
    undo();
    const a = db
      .prepare("SELECT message_id, conversation_id FROM attachments WHERE id = 'att1'")
      .get() as { message_id: string | null; conversation_id: string | null };
    expect(a.message_id).toBeNull();
    expect(a.conversation_id).toBeNull();
  });

  it("取り消したあとに送り直しても、発言は二重にならない", () => {
    setup();
    undo();
    // 送り直し
    db.prepare(
      `INSERT INTO messages (id, conversation_id, parent_id, role, content, status, created_at)
       VALUES ('u2', 'c1', 'old-leaf', 'user', 'こんにちは', 'done', 4)`,
    ).run();
    expect(
      count("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND content = 'こんにちは'"),
    ).toBe(1);
  });

  it("「生成中」のまま残る行が無くなる", () => {
    setup();
    undo();
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE status = 'streaming'")).toBe(0);
  });
});

/**
 * 消す候補の控え（監査 B-10）。
 *
 * 実体（R2）は分岐・フォークで共有される。以前は行を消したあとに
 * 生き残りを数え、0なら落としていたが、数えてから落とすまでのあいだに
 * フォークが走ると参照が復活したキーを消してしまう——**行だけ残って
 * 画像が出ない**状態になり、取り返しがつかない。
 *
 * D1 と R2 はまたいで原子的に扱えないので、代わりに時間を空ける。
 * ここで見るのは「落とす直前に数え直している」ことと、その数え直しが
 * 復活した参照を拾えること。
 */
describe("消す候補の控え", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_700_000_000_000;

  /** 控える。 */
  function queue(key: string, at: number): void {
    db.prepare(QUEUE_PENDING_DELETION_SQL).run(key, at);
  }

  /** 猶予を過ぎた控えを引く。 */
  function due(at = now): string[] {
    return (
      db
        .prepare(DUE_PENDING_DELETIONS_SQL)
        .all(at - PENDING_DELETION_GRACE_MS) as { r2_key: string }[]
    ).map((r) => r.r2_key);
  }

  /** まだ参照されているキーを引く。 */
  function referenced(keys: string[]): string[] {
    return (
      db.prepare(stillReferencedSql(keys.length)).all(...keys) as {
        r2_key: string;
      }[]
    ).map((r) => r.r2_key);
  }

  /** 添付の行を1つ置く（フォークで増える行の代わり）。 */
  function attach(id: string, key: string): void {
    db.prepare(
      "INSERT INTO attachments (id, message_id, conversation_id, r2_key, mime_type, name, size, created_at) VALUES (?, NULL, NULL, ?, 'image/png', ?, 1, ?)",
    ).run(id, key, `${id}.png`, now);
  }

  beforeEach(() => {
    migrate(db);
  });

  it("控えの表がある", () => {
    const columns = db
      .prepare("PRAGMA table_info(pending_file_deletions)")
      .all() as { name: string }[];
    expect(columns.map((c) => c.name).sort()).toEqual(["noticed_at", "r2_key"]);
  });

  it("猶予を過ぎたものだけが対象になる", () => {
    queue("ふるい", now - HOUR);
    queue("さっき", now);
    expect(due()).toEqual(["ふるい"]);
  });

  /**
   * この仕組みの要。控えた時点では誰も参照していなくても、猶予のあいだに
   * フォークで参照が復活していることがある。落とす直前に数え直すので、
   * 復活したぶんはここで生き残る。
   */
  it("控えたあとに参照が復活したキーは、落とさない", () => {
    queue("共有されている", now - HOUR);
    queue("もう誰も見ていない", now - HOUR);
    // フォークが実体を共有したまま行だけ複製した
    attach("フォーク後の行", "共有されている");

    const keys = due();
    expect(keys.sort()).toEqual(["もう誰も見ていない", "共有されている"].sort());

    const alive = referenced(keys);
    expect(alive).toEqual(["共有されている"]);
    // 落とすのは、生き残らなかったほうだけ
    expect(keys.filter((k) => !alive.includes(k))).toEqual([
      "もう誰も見ていない",
    ]);
  });

  it("同じキーを控え直しても、時計は戻らない", () => {
    queue("キー", now - HOUR);
    queue("キー", now);
    expect(due()).toEqual(["キー"]);
    const rows = db
      .prepare("SELECT noticed_at FROM pending_file_deletions WHERE r2_key = ?")
      .all("キー") as { noticed_at: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].noticed_at).toBe(now - HOUR);
  });

  it("見終わった控えは、生き残ったぶんも外す", () => {
    queue("生き残り", now - HOUR);
    queue("落とすほう", now - HOUR);
    attach("行", "生き残り");

    const keys = due();
    db.prepare(clearPendingDeletionsSql(keys.length)).run(...keys);
    expect(due()).toEqual([]);
    // 生き残りは行が残っているので、また用済みになれば削除の側が控え直す
    expect(referenced(["生き残り"])).toEqual(["生き残り"]);
  });
});
