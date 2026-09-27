import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, statementsOf } from "../../app/lib/schema";

/**
 * D1 の代わりに node:sqlite を薄く包んだもの。流れる SQL は本番のもの。
 *
 * 往復（batch は1回、単発の文も1回）を数える。送信から上流へ投げる
 * までの時間は、ほぼこの往復の数で決まる。
 *
 * D1 と同じく、1文のバインドが100個を超えたら投げる。SQLite 自体は
 * もっと受け付けるので、ここで止めないと「本番でだけ送信が通らない」
 * 分割し忘れがテストを素通りする。
 */
export interface D1Trace {
  roundTrips: number;
  /** 流れた文と、そのバインドの数。 */
  statements: { sql: string; binds: number }[];
}

export const D1_MAX_BINDS = 100;

export function makeD1(db: DatabaseSync, trace: () => D1Trace) {
  const statement = (sql: string, args: unknown[] = []) => {
    const exec = () => {
      if (args.length > D1_MAX_BINDS) {
        throw new Error(
          `D1_ERROR: too many SQL variables (${args.length} > ${D1_MAX_BINDS})`,
        );
      }
      trace().statements.push({ sql, binds: args.length });
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
        trace().roundTrips++;
        return exec();
      },
      async first() {
        trace().roundTrips++;
        return exec().results[0] ?? null;
      },
      async run() {
        trace().roundTrips++;
        return exec();
      },
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    async batch(list: ReturnType<typeof statement>[]) {
      trace().roundTrips++;
      return list.map((s) => s.exec());
    },
    async exec(sql: string) {
      trace().roundTrips++;
      db.exec(sql);
    },
  };
}

/** 全マイグレーションを流し、適用済みと記録した空のデータベース。 */
export function freshDb(): DatabaseSync {
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
