/**
 * D1 の代わりに node:sqlite を薄く包んだもの。
 *
 * 流れる SQL は本番の db.server が組み立てたものそのまま。往復の回数
 * （batch は全体で1回、単発の文も1回）を数えられるので、「書き込みを
 * 足したらサブリクエストが増えた」を見張れる。
 *
 * 使う側は `vi.mock("cloudflare:workers", ...)` で env.DB にこれを返す。
 */
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, statementsOf } from "../../../app/lib/schema";

export interface SqliteD1 {
  db: DatabaseSync;
  /** これまでの D1 への往復。 */
  roundTrips: number;
  /** 渡す先（env.DB）。 */
  binding: unknown;
}

/** スキーマを最後まで流した、空のデータベース。 */
export function freshSqliteD1(): SqliteD1 {
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
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
    String(MIGRATIONS.length),
  );

  const self: SqliteD1 = { db, roundTrips: 0, binding: null };
  const statement = (sql: string, args: unknown[] = []) => {
    const exec = () => {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|WITH)/i.test(sql)) {
        const rows = st.all(...(args as never[])) as Record<string, unknown>[];
        return { results: rows, meta: { changes: 0 } };
      }
      const info = st.run(...(args as never[]));
      return { results: [], meta: { changes: Number(info.changes) } };
    };
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      exec,
      async all() {
        self.roundTrips++;
        return exec();
      },
      async first() {
        self.roundTrips++;
        return exec().results[0] ?? null;
      },
      async run() {
        self.roundTrips++;
        return exec();
      },
    };
  };
  self.binding = {
    prepare: (sql: string) => statement(sql),
    async batch(list: ReturnType<typeof statement>[]) {
      self.roundTrips++;
      return list.map((s) => s.exec());
    },
    async exec(sql: string) {
      db.exec(sql);
    },
  };
  return self;
}
