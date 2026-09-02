import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONVERSATIONS_SIDEBAR_SQL,
  DUE_PENDING_DELETIONS_SQL,
  GENERATING_CONVERSATIONS_SQL,
  MIGRATIONS,
  PENDING_DELETION_GRACE_MS,
  QUEUE_PENDING_DELETION_SQL,
  STALE_STREAMING_MS,
  STORAGE_STATS_SQL,
  USAGE_DAILY_SQL,
  USAGE_TOTALS_SQL,
  appendAssistantMessageStatements,
  clearPendingDeletionsSql,
  generatedImagesSql,
  searchConversationsSql,
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

  const totals = (since = 0) =>
    db.prepare(USAGE_TOTALS_SQL).get(since) as Record<string, number>;

  /**
   * 日別のグラフ。日は JST で切る。UTC で切ると 09:00 JST より前の
   * 使用が前の日に数えられ、朝の分だけ棒が1本ずれる。
   */
  it("日別の内訳は JST の日付で切る", () => {
    addMessage("m1", "c1", "openai/gpt-4o");
    addMessage("m2", "c1", "openai/gpt-4o");
    addMessage("m3", "c1", "anthropic/claude");
    // 2026-09-02 00:00 JST = 2026-09-01 15:00 UTC
    const jstMidnight = Date.UTC(2026, 8, 1, 15, 0, 0);
    const insert = (id: string, mid: string, at: number, cost: number) =>
      db
        .prepare(
          `INSERT INTO usage_events (id, at, kind, provider, model_id, cost_usd, points, conversation_id, message_id)
           SELECT ?, ?, 'chat', 'openrouter', model_id, ?, NULL, conversation_id, id FROM messages WHERE id = ?`,
        )
        .run(id, at, cost, mid);
    insert("e1", "m1", jstMidnight - 1, 1); // JST では 9/1 の 23:59:59.999
    insert("e2", "m2", jstMidnight, 2); // JST では 9/2 の 00:00:00
    insert("e3", "m3", jstMidnight + 1000, 4); // 同じ日、別のモデル

    const rows = db.prepare(USAGE_DAILY_SQL).all(0) as {
      day: number;
      model_id: string;
      cost_usd: number;
      events: number;
    }[];
    const dayOf = (at: number) => Math.floor((at + 9 * 3600 * 1000) / 86_400_000);
    expect(rows.map((r) => [r.day - dayOf(jstMidnight), r.model_id, r.cost_usd])).toEqual([
      [-1, "openai/gpt-4o", 1],
      [0, "anthropic/claude", 4],
      [0, "openai/gpt-4o", 2],
    ]);
  });

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
    // 期間の切り方も本番と同じ文で見る（画面の期間切り替えはこれ1本）
    expect(totals(0).cost_usd).toBeCloseTo(3);
    expect(totals(200).cost_usd).toBeCloseTo(2);
    expect(totals(400).cost_usd).toBeCloseTo(0);
    expect(totals(200).events).toBe(1);
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
/**
 * サイドバーに出す会話の一覧。
 *
 * `SELECT *` で引くと、会話が作成時に写し取った system_prompt と
 * params_json まで付いてくる。どちらも長さに上限が無く、サイドバーは
 * 読まない。サイドバーは全ページの土台なので、載せるとどの画面を開いても
 * その全文がHTMLへ乗る（会話200件・system_prompt 800字で 99KB → 261KB）。
 *
 * 列を並べて書く以上、書き間違いは本番でしか出ない（`SELECT *` なら
 * 起きなかった失敗の仕方）。本物の SQLite に流して確かめる。
 */
describe("サイドバーの会話一覧", () => {
  beforeEach(() => migrate(db));

  const addConversation = (
    id: string,
    o: { pinned?: number; updatedAt?: number } = {},
  ) =>
    db
      .prepare(
        `INSERT INTO conversations (id, title, model_id, pinned,
           current_leaf_message_id, system_prompt, params_json,
           created_at, updated_at)
         VALUES (?, ?, 'openai/gpt-4o', ?, NULL, ?, ?, 1, ?)`,
      )
      .run(
        id,
        `題 ${id}`,
        o.pinned ?? 0,
        "あ".repeat(800),
        '{"temperature":0.7}',
        o.updatedAt ?? 1,
      );

  /** 本番と同じSQL（書き写さない）。 */
  const list = () =>
    db.prepare(CONVERSATIONS_SIDEBAR_SQL).all() as Record<string, unknown>[];

  it("重い列（system_prompt・params_json）は付いてこない", () => {
    addConversation("a");
    const [row] = list();
    // 行そのものは引けている。これが無いと「空だから含まれない」でも通る
    expect(row.id).toBe("a");
    expect(row.title).toBe("題 a");
    expect(Object.keys(row)).not.toContain("system_prompt");
    expect(Object.keys(row)).not.toContain("params_json");
  });

  it("サイドバーが読む列は揃っている", () => {
    addConversation("a");
    const [row] = list();
    // 画面が使う列。1つでも欠けると、印や並べ替えが黙って効かなくなる
    for (const column of [
      "id",
      "title",
      "pinned",
      "favorite",
      "unread",
      "folder_id",
      "sort_order",
      "created_at",
      "updated_at",
      "bot_icon",
      "model_id",
      "current_leaf_message_id",
    ]) {
      expect(Object.keys(row)).toContain(column);
    }
  });

  it("ピン留めが先、そのあとは更新の新しい順", () => {
    addConversation("古", { updatedAt: 100 });
    addConversation("新", { updatedAt: 300 });
    addConversation("ピン", { pinned: 1, updatedAt: 1 });
    expect(list().map((r) => r.id)).toEqual(["ピン", "新", "古"]);
  });
});

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

/**
 * サイドバーが「いま生成中の会話」を引く問い合わせ。
 *
 * 行の status だけを見ると、生成側が落ちたまま残った行（中断検知が
 * 走るのは会話を開いたときだけ）を永久に光らせてしまう。書き込みを
 * 伴わずに消えることまで見る。
 */
describe("生成中の会話", () => {
  beforeEach(() => migrate(db));

  const now = 10_000_000;
  const add = (
    id: string,
    conv: string,
    status: string,
    flushedAt: number | null,
  ) =>
    db
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, content, status, flushed_at, created_at) VALUES (?, ?, 'assistant', '', ?, ?, ?)",
      )
      .run(id, conv, status, flushedAt, now);

  const generating = (at = now) =>
    (
      db
        .prepare(GENERATING_CONVERSATIONS_SQL)
        .all(at - STALE_STREAMING_MS) as { id: string }[]
    ).map((r) => r.id);

  it("生成中の会話が出る", () => {
    add("m1", "c1", "streaming", now);
    add("m2", "c2", "done", now);
    expect(generating()).toEqual(["c1"]);
  });

  it("同じ会話で2本走っていても1件にまとまる", () => {
    add("m1", "c1", "streaming", now);
    add("m2", "c1", "streaming", now);
    expect(generating()).toEqual(["c1"]);
  });

  it("しばらく書き込みの無い行は、生成中とみなさない", () => {
    add("m1", "c1", "streaming", now - STALE_STREAMING_MS - 1);
    expect(generating()).toEqual([]);
  });

  it("flushed_at が無い行は、作られた時刻で見る", () => {
    // 始まった直後（まだ一度も書いていない）は生成中に数える
    add("m1", "c1", "streaming", null);
    expect(generating()).toEqual(["c1"]);
    // 作られてから時間が経てば、書き込みが無いまま止まったとみなす
    expect(generating(now + STALE_STREAMING_MS + 1)).toEqual([]);
  });
});

/**
 * 「成功するまで生成」で応答を1件積む文。
 *
 * 未読の印がここで立つことが要（生成の確定まで待つと、1件目の成功が
 * 届いても別の画面からは気づけない）。
 */
describe("応答を積む", () => {
  beforeEach(() => {
    migrate(db);
    db.prepare(
      "INSERT INTO conversations (id, title, unread, current_leaf_message_id, created_at, updated_at) VALUES ('c1', '画像', 0, 'u1', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('u1', 'c1', 'user', '猫の絵', 1)",
    ).run();
  });

  const append = (id: string, parentId: string) => {
    for (const st of appendAssistantMessageStatements({
      id,
      conversationId: "c1",
      parentId,
      modelId: "poe:Imagen",
      content: `![](/api/files/${id})`,
      usageJson: null,
      now: 2_000,
    })) {
      db.prepare(st.sql).run(...st.binds);
    }
  };

  const conversation = () =>
    db.prepare("SELECT * FROM conversations WHERE id = 'c1'").get() as Record<
      string,
      unknown
    >;

  it("1件目の成功で未読の印が立つ", () => {
    expect(conversation().unread).toBe(0);
    append("a1", "u1");
    expect(conversation().unread).toBe(1);
  });

  it("別の枝を見ているあいだは、表示中の枝を奪わない", () => {
    /*
     * 実行中でも別の枝へ移れる。無条件に葉を動かしていたので、成功が
     * 1件届くたびに表示が実行の枝へ引き戻されていた（数秒おきに勝手に
     * 画面が変わる）。未読と更新時刻は動かす——届いたのは本当なので。
     */
    db.prepare(
      "INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at) VALUES ('u2', 'c1', NULL, 'user', '別の枝', 1)",
    ).run();
    db.prepare(
      "UPDATE conversations SET current_leaf_message_id = 'u2', unread = 0, updated_at = 1 WHERE id = 'c1'",
    ).run();

    append("a1", "u1");

    const c = conversation();
    expect(c.current_leaf_message_id).toBe("u2");
    expect(c.unread).toBe(1);
    expect(c.updated_at).toBe(2000);
    // 応答そのものは、実行の枝に積まれている
    const row = db
      .prepare("SELECT parent_id FROM messages WHERE id = 'a1'")
      .get() as { parent_id: string };
    expect(row.parent_id).toBe("u1");
  });

  it("実行の枝へ戻れば、また付いていく", () => {
    append("a1", "u1");
    // 別の枝へ移る
    db.prepare(
      "UPDATE conversations SET current_leaf_message_id = 'u1' WHERE id = 'c1'",
    ).run();
    append("a2", "a1");
    expect(conversation().current_leaf_message_id).toBe("u1");
    // 枝の切り替えは葉を実行の枝の末尾（a2）へ置き直す
    db.prepare(
      "UPDATE conversations SET current_leaf_message_id = 'a2' WHERE id = 'c1'",
    ).run();
    append("a3", "a2");
    expect(conversation().current_leaf_message_id).toBe("a3");
  });

  it("積んだ応答が表示中の枝の先になる", () => {
    append("a1", "u1");
    expect(conversation().current_leaf_message_id).toBe("a1");
    // 成功は前の成功の下に繋がる（左右の切り替えなしで全部見える）
    append("a2", "a1");
    expect(conversation().current_leaf_message_id).toBe("a2");
    const rows = db
      .prepare("SELECT id, parent_id, status FROM messages ORDER BY id")
      .all() as { id: string; parent_id: string; status: string }[];
    expect(rows.map((r) => [r.id, r.parent_id])).toEqual([
      ["a1", "u1"],
      ["a2", "a1"],
      ["u1", null],
    ]);
    // 積んだ時点で確定済み（生成中のまま残らない）
    expect(rows.find((r) => r.id === "a1")?.status).toBe("done");
  });

  /*
   * 台帳（usage_events）もこの文で積まれること。
   *
   * finalizeGeneration に任せていたときは、この経路（成功を積む）が
   * 台帳を素通りし、リトライ生成の OpenRouter 課金が使用量画面にも
   * 月間上限にも一切現れなかった。
   */
  const appendWithUsage = (
    id: string,
    parentId: string,
    usageJson: string | null,
    modelId = "google/gemini-image",
  ) => {
    for (const st of appendAssistantMessageStatements({
      id,
      conversationId: "c1",
      parentId,
      modelId,
      content: `![](/api/files/${id})`,
      usageJson,
      now: 2_000,
    })) {
      db.prepare(st.sql).run(...st.binds);
    }
  };
  const ledger = () =>
    db.prepare("SELECT * FROM usage_events").all() as Record<
      string,
      unknown
    >[];

  it("使用量が台帳へ載る", () => {
    appendWithUsage(
      "a1",
      "u1",
      JSON.stringify({ cost: 0.12, promptTokens: 10, completionTokens: 20 }),
    );
    const rows = ledger();
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("retry");
    expect(rows[0].provider).toBe("openrouter");
    expect(rows[0].cost_usd).toBe(0.12);
    expect(rows[0].prompt_tokens).toBe(10);
    expect(rows[0].completion_tokens).toBe(20);
    expect(rows[0].conversation_id).toBe("c1");
    expect(rows[0].message_id).toBe("a1");
  });

  it("Poe のモデルは provider が poe になる", () => {
    appendWithUsage("a1", "u1", JSON.stringify({ points: 30 }), "poe:Imagen");
    const rows = ledger();
    expect(rows.length).toBe(1);
    expect(rows[0].provider).toBe("poe");
    expect(rows[0].points).toBe(30);
  });

  it("額もポイントも無い応答は台帳に載せない", () => {
    appendWithUsage("a1", "u1", null);
    appendWithUsage("a2", "a1", JSON.stringify({ promptTokens: 5 }));
    expect(ledger().length).toBe(0);
    // メッセージ自体は積まれている（台帳の有無と応答の保存は別）
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number })
        .n,
    ).toBe(3);
  });

  it("同じ応答を二度数えようとしても、二重には載らない", () => {
    appendWithUsage("a1", "u1", JSON.stringify({ cost: 0.5 }));
    // 台帳の文だけをもう一度流す（message_id の一意索引で弾かれる）
    const usageSt = appendAssistantMessageStatements({
      id: "a1",
      conversationId: "c1",
      parentId: "u1",
      modelId: "google/gemini-image",
      content: "x",
      usageJson: JSON.stringify({ cost: 0.5 }),
      now: 2_000,
    }).find((st) => st.sql.includes("usage_events"));
    expect(usageSt).toBeDefined();
    db.prepare(usageSt!.sql).run(...usageSt!.binds);
    expect(ledger().length).toBe(1);
  });
});

/**
 * 保管しているものの大きさ（使用量の画面の Cloudflare 欄）。
 *
 * 実体はフォークや分岐で共有される。行の数で数えると、共有している
 * ぶんを何度も足してしまう——「R2 に置いてある量」としては嘘になる。
 */
describe("保管しているものの大きさ", () => {
  beforeEach(() => migrate(db));

  const addFile = (id: string, key: string, size: number) =>
    db
      .prepare(
        "INSERT INTO attachments (id, r2_key, mime_type, size, kind, created_at) VALUES (?, ?, 'image/png', ?, 'generated', 1)",
      )
      .run(id, key, size);

  const stats = () =>
    db.prepare(STORAGE_STATS_SQL).get() as Record<string, number>;

  it("何も無ければ 0 が並ぶ", () => {
    const s = stats();
    expect(s.conversations).toBe(0);
    expect(s.files).toBe(0);
    expect(s.file_bytes).toBe(0);
  });

  it("同じ実体を指す行は、1つぶんとして数える", () => {
    addFile("f1", "k1", 1000);
    // フォークで増えた行。実体は同じなので R2 の使用量は増えない
    addFile("f2", "k1", 1000);
    addFile("f3", "k2", 500);
    const s = stats();
    expect(s.files).toBe(2);
    expect(s.file_bytes).toBe(1500);
  });

  it("会話・メッセージ・台帳の件数が出る", () => {
    db.prepare(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'x', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1', 'c1', 'user', 'x', 1)",
    ).run();
    db.prepare(
      "INSERT INTO usage_events (id, at, kind, provider, cost_usd) VALUES ('e1', 1, 'chat', 'openrouter', 1)",
    ).run();
    db.prepare(
      "INSERT INTO pending_file_deletions (r2_key, noticed_at) VALUES ('k9', 1)",
    ).run();
    const s = stats();
    expect(s.conversations).toBe(1);
    expect(s.messages).toBe(1);
    expect(s.usage_events).toBe(1);
    expect(s.pending_deletions).toBe(1);
  });
});

/**
 * 会話検索の文。
 *
 * 抜粋の元（最初の検索語がヒットした本文）は hit 列として本体に同梱される。
 * 結果行ごとに別の SELECT を投げていたときは、検索1回で D1 へ最大51往復
 * していた。文を書き写さず、本番と同じものをここで流す。
 */
describe("会話検索", () => {
  beforeEach(() => {
    migrate(db);
    const conv = db.prepare(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, 1, ?)",
    );
    conv.run("c1", "猫の話", 3);
    conv.run("c2", "犬の話", 2);
    conv.run("c3", "無関係", 1);
    const msg = db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, 1)",
    );
    msg.run("m1", "c1", "うちの猫はよく寝る");
    msg.run("m2", "c2", "犬の散歩と猫よけの話");
    msg.run("m3", "c3", "天気の話だけ");
  });

  const search = (positives: string[], negatives: string[] = []) => {
    const sql = searchConversationsSql({
      positives: positives.length,
      negatives: negatives.length,
    });
    const like = (t: string) => `%${t}%`;
    const binds = [like(positives[0])];
    for (const t of [...positives, ...negatives]) binds.push(like(t), like(t));
    return db.prepare(sql).all(...binds) as {
      id: string;
      title: string;
      hit: string | null;
    }[];
  };

  it("タイトルと本文の両方から探し、新しい順に出る", () => {
    expect(search(["猫"]).map((r) => r.id)).toEqual(["c1", "c2"]);
  });

  it("抜粋の元になる本文が同じ行に載る", () => {
    const rows = search(["猫"]);
    expect(rows[0].hit).toBe("うちの猫はよく寝る");
    // タイトルにしか無い会話でも、本文のヒットがあればそれが載る
    expect(rows[1].hit).toBe("犬の散歩と猫よけの話");
  });

  it("本文にヒットが無ければ hit は空（会話は出る）", () => {
    db.prepare(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c4', '猫だけのタイトル', 1, 4)",
    ).run();
    const rows = search(["猫"]);
    expect(rows[0].id).toBe("c4");
    expect(rows[0].hit).toBeNull();
  });

  it("空白区切りは AND、-語 は除外", () => {
    expect(search(["猫", "犬"]).map((r) => r.id)).toEqual(["c2"]);
    expect(search(["話"], ["犬"]).map((r) => r.id)).toEqual(["c1", "c3"]);
  });

  it("最大語数でもバインドは D1 の上限（100個）に収まる", () => {
    // 語は10個で頭打ち（db.server.ts の MAX_SEARCH_TERMS）
    const sql = searchConversationsSql({ positives: 10, negatives: 0 });
    expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
  });
});

/**
 * 索引と実クエリの突き合わせ。
 *
 * 索引が無くても画面は同じに見え、効いてくるのは無料枠（読んだ行数）を
 * 使い切ったときだけ——「静かに壊れる結び付き」なので、実行計画で見張る。
 * v16 で「生成中」に索引を足したとき、同じ batch の隣の文（未読）と
 * 会話削除（attachments.conversation_id）が漏れていた。同じ見落としを
 * 繰り返さないためのガード。
 */
describe("索引が効いている", () => {
  beforeEach(() => migrate(db));

  const plan = (sql: string): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
      .map((r) => r.detail)
      .join("\n");

  it("未読の一覧（5秒ごと）は全表走査にならない", () => {
    const p = plan("SELECT id FROM conversations WHERE unread = 1");
    expect(p).toContain("idx_conversations_unread");
    expect(p).not.toMatch(/SCAN conversations(?! USING)/);
  });

  it("会話削除の添付の収集と削除は全表走査にならない", () => {
    for (const sql of [
      "SELECT r2_key FROM attachments WHERE conversation_id = 'c1'",
      "DELETE FROM attachments WHERE conversation_id = 'c1'",
    ]) {
      const p = plan(sql);
      expect(p).toContain("idx_attachments_conversation");
      expect(p).not.toMatch(/SCAN attachments(?! USING)/);
    }
  });

  it("生成中の会話（5秒ごと）は全表走査にならない", () => {
    const p = plan(GENERATING_CONVERSATIONS_SQL.replace("?", "0"));
    expect(p).toContain("idx_messages_streaming");
  });
});
