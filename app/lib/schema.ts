/**
 * スキーマの定義と、それを流すための小物。
 *
 * db.server.ts から切り出してある。あちらは cloudflare:workers を読むので
 * Workers の外からは触れないが、スキーマそのものは素の SQL でしかない。
 * 別にしておけば、本物の SQLite に流して構文と索引を確かめられる
 * （壊れたマイグレーションはアプリ全体を起動不能にするため）。
 */

/**
 * バージョン管理付きのランタイムマイグレーション。配列に追記していく。
 * 適用済みバージョンは meta テーブルに記録される。
 */
export const MIGRATIONS: string[] = [
  // v1: 初期スキーマ
  `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  current_leaf_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model_id TEXT,
  usage_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
`,
  // v2: ボット + 会話へのボットスナップショット
  `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🤖',
  model_id TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  params_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE conversations ADD COLUMN bot_id TEXT;
ALTER TABLE conversations ADD COLUMN bot_name TEXT;
ALTER TABLE conversations ADD COLUMN bot_icon TEXT;
ALTER TABLE conversations ADD COLUMN system_prompt TEXT;
ALTER TABLE conversations ADD COLUMN params_json TEXT;
`,
  // v3: 思考（reasoning）内容の保存
  `
ALTER TABLE messages ADD COLUMN reasoning TEXT;
`,
  // v4: サーバー側生成（生成中ステータス・エラー・停止フラグ）
  `
ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE messages ADD COLUMN error TEXT;
ALTER TABLE messages ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0;
`,
  // v5: 生成中の最終更新時刻（中断検知・自動復旧用）
  `
ALTER TABLE messages ADD COLUMN flushed_at INTEGER;
`,
  // v6: フォルダ + ピン留めの並べ替え
  `
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE conversations ADD COLUMN folder_id TEXT;
ALTER TABLE conversations ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
`,
  // v7: 添付ファイル（画像）。実体はR2、ここにはメタデータのみ。
  // message_id はアップロード直後は NULL（送信時にメッセージへ紐づける）。
  `
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  conversation_id TEXT,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  name TEXT,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_key ON attachments(r2_key);
`,
  // v8: 生成画像。モデルが返した画像もR2へ取り込み、上流CDNの期限切れで
  // 過去の会話から消えないようにする。kind で用途を分ける。
  `
ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'upload';
CREATE INDEX IF NOT EXISTS idx_attachments_kind ON attachments(kind, created_at);
`,
  // v9: 未読。応答の完成を会話一覧で知らせるため、生成の確定時に立てて
  // その会話を開いたときに落とす。
  `
ALTER TABLE conversations ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
`,
  // v10: 画像一覧のお気に入りと検索。prompt は生成時の依頼文の写しで、
  // 会話ツリーを遡らずに検索できるようにするために持つ。
  `
ALTER TABLE attachments ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN prompt TEXT;
CREATE INDEX IF NOT EXISTS idx_attachments_favorite ON attachments(favorite, created_at);
`,
  // v11: 会話のお気に入り。ピン留め（サイドバー最上部への固定）とは別で、
  // 常設の「お気に入り」フォルダに集める印。両方付けられる。
  `
ALTER TABLE conversations ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_conversations_favorite ON conversations(favorite, updated_at);
`,
  // v12: コンテキストの境界線。1 が立ったメッセージまでを以後モデルへ
  // 送らない（履歴自体は残る）。解除すれば元どおり全部が文脈に戻る。
  `
ALTER TABLE messages ADD COLUMN context_boundary INTEGER NOT NULL DEFAULT 0;
`,
  // v13: 応答の参照元。本文（content）とは別に持つ。ここへ混ぜると
  // 次のターンでモデルへ送り返す履歴が変わってしまうため。
  `
ALTER TABLE messages ADD COLUMN citations_json TEXT;
`,
  // v14: 使用量の台帳。
  //
  // messages.usage_json とは別に持つ。あちらは応答の詳細表示のためのもので、
  // 会話やメッセージを消せば一緒に消える。月間の上限は「使った額」で判定
  // するのだから、消しても減ってはいけない——会話を消すと上限が緩む、
  // という穴になる。会話IDは参照のために持つだけで、外部キーも
  // ON DELETE も張らない。
  //
  // message_id の一意制約は、同じ応答を二度確定しても二重に数えない
  // ためのもの。タイトル生成のように応答へ紐づかない支出は message_id が
  // NULL になるが、SQLite は一意索引の中で NULL どうしを別物として
  // 扱うので、そちらはいくつでも入る。
  `
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT,
  cost_usd REAL,
  points REAL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  conversation_id TEXT,
  message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_events(at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_message ON usage_events(message_id) WHERE message_id IS NOT NULL;
`,
  // v15: 消す候補になったR2のキーの控え。
  //
  // 実体は分岐・フォークで共有されるので、行を消したあとに「もう誰も
  // 参照していないか」を数えてから落としている。ところが数えてから
  // 落とすまでのあいだにフォークが走ると、参照が復活したキーを消して
  // しまう——**行だけ残って画像が出ない**状態になり、取り返しがつかない。
  //
  // D1 と R2 はまたいで原子的に扱えないので、代わりに時間を空ける。
  // 消す候補をここへ控え、しばらく経ってから数え直して落とす。フォークは
  // 1回の要求で読んで書くので、控えてから猶予が過ぎるまでのあいだ
  // ずっと途中で止まっていることは無い。
  //
  // 控えが残ったままでも害は無い（実体が消え残るだけ）。逆は取り返しが
  // つかない、という向きは他の削除と同じ。
  `
CREATE TABLE IF NOT EXISTS pending_file_deletions (
  r2_key TEXT PRIMARY KEY,
  noticed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_deletion_at ON pending_file_deletions(noticed_at);
`,
  // v16: 生成中の行だけを引くための索引。
  //
  // サイドバーは「いま生成中の会話」を数秒おきに引く（タイトルを
  // 光らせるため）。索引が無いと messages 全体の走査になり、会話が
  // 増えるほど**5秒ごとに**重くなる。生成中の行は多くても数件なので、
  // 条件付き索引にして索引自体も小さく保つ。
  `
CREATE INDEX IF NOT EXISTS idx_messages_streaming
  ON messages(conversation_id) WHERE status = 'streaming';
`,
];

/**
 * 消す候補を控えてから、実際に落とすまでの猶予。
 *
 * フォークが「参照している行を読む」→「新しい行を書く」までに挟まりうる
 * 時間より十分長く取る（実測では1回の要求で完結するので1秒に満たない）。
 */
export const PENDING_DELETION_GRACE_MS = 10 * 60 * 1000;

/** 一度の掃除で見る件数。サブリクエストを使い切らないよう区切る。 */
export const PENDING_DELETION_SWEEP_LIMIT = 100;

/** 消す候補を控える。すでに控えてあるキーは時計を戻さない。 */
export const QUEUE_PENDING_DELETION_SQL =
  "INSERT INTO pending_file_deletions (r2_key, noticed_at) VALUES (?, ?) ON CONFLICT(r2_key) DO NOTHING";

/** 猶予を過ぎた控え。 */
export const DUE_PENDING_DELETIONS_SQL = `SELECT r2_key FROM pending_file_deletions WHERE noticed_at <= ? ORDER BY noticed_at LIMIT ${PENDING_DELETION_SWEEP_LIMIT}`;

/**
 * まだどれかの添付行から参照されているキー。
 *
 * 控えた時点ではなく**落とす直前**にこれを引くのが、この仕組みの要。
 * 控えてから猶予のあいだに参照が復活したものは、ここで生き残る。
 */
export function stillReferencedSql(count: number): string {
  return `SELECT DISTINCT r2_key FROM attachments WHERE r2_key IN (${Array.from(
    { length: count },
    () => "?",
  ).join(",")})`;
}

/** 見終わった控えを外す（落としたものも、生き残ったものも）。 */
export function clearPendingDeletionsSql(count: number): string {
  return `DELETE FROM pending_file_deletions WHERE r2_key IN (${Array.from(
    { length: count },
    () => "?",
  ).join(",")})`;
}

/** 版のSQLを文単位に割る。1文ずつ流すことで、どこまで進んだかを揃える。 */
export function statementsOf(sql: string): string[] {
  return sql
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

/**
 * 生成画像の一覧を引くSQL。
 *
 * 本体（db.server.ts）と、SQLite に流して確かめるテストの両方が
 * これを使う。手で書き写すと、片方だけ直したときに気づけない。
 *
 * 続きを読む位置（before）は HAVING で切る。WHERE で切ると、まとめる前の
 * 1行ずつに効いてしまう——フォークで実体を共有する画像は行が複数あるので、
 * 1ページ目に新しいほうの行で出たあと、2ページ目では古いほうの行が残って
 * **同じ画像がもう一度出る**。
 *
 * HAVING では別名（created_at）ではなく MAX(a.created_at) と書く。
 * messages にも created_at があるため、別名だとどちらを指すのか
 * 決まらず「ambiguous column name」で問い合わせごと失敗する。
 *
 * @param conditions WHERE に足す条件（お気に入りのみ・検索語など）
 */
export function generatedImagesSql(conditions: string[]): string {
  const where = ["a.kind = 'generated'", ...conditions].join(" AND ");
  // MAX() と併記した列はその最大行の値になる（SQLiteの規定の挙動）ので、
  // まとめたあとに残るのは最新の1行
  return `SELECT a.id, a.conversation_id, a.message_id,
              MAX(a.created_at) AS created_at,
              a.favorite, a.prompt,
              c.title AS title, m.model_id AS model_id
         FROM attachments a
         LEFT JOIN conversations c ON c.id = a.conversation_id
         LEFT JOIN messages m ON m.id = a.message_id
        WHERE ${where}
        GROUP BY a.r2_key
       HAVING MAX(a.created_at) < ?
        ORDER BY created_at DESC
        LIMIT ?`;
}

/** 実行する1文。バインドする値と組で返す。 */
export interface Statement {
  sql: string;
  binds: (string | number | null)[];
}

/**
 * 生成の開始を取り消す文。
 *
 * 本体（db.server.ts）と、SQLite に流して確かめるテストの両方がこれを
 * 使う。手で書き写すと、片方だけ直したときに気づけない。
 *
 * 順序に意味がある。添付の紐づけを外すのは、行を消すより**先**——
 * メッセージの行が消えたあとでは、どの添付だったのか辿れない。
 */
export function undoGenerationStatements(params: {
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string;
  previousLeafId: string | null;
}): Statement[] {
  const out: Statement[] = [];
  if (params.userMessageId) {
    out.push({
      sql: "UPDATE attachments SET message_id = NULL, conversation_id = NULL WHERE message_id = ?",
      binds: [params.userMessageId],
    });
  }
  out.push({
    sql: "DELETE FROM messages WHERE id = ?",
    binds: [params.assistantMessageId],
  });
  if (params.userMessageId) {
    out.push({
      sql: "DELETE FROM messages WHERE id = ?",
      binds: [params.userMessageId],
    });
  }
  out.push({
    sql: "UPDATE conversations SET current_leaf_message_id = ? WHERE id = ?",
    binds: [params.previousLeafId, params.conversationId],
  });
  return out;
}

/**
 * 「生成が止まった」とみなすまでの無音時間。
 *
 * db.server.ts の中断検知（sweepStaleStreaming）と同じ値を使う。ここで
 * 別の値にすると、サイドバーだけが**もう動いていない生成を光らせ続ける**
 * ことになる（生成側が落ちても行は streaming のまま残るため）。
 */
export const STALE_STREAMING_MS = 60 * 1000;

/**
 * いま生成中の会話ID。
 *
 * サイドバーはこれを数秒おきに引き、タイトルを光らせる。行の status
 * だけを見ると、生成側が落ちたまま残った行（中断検知が走るのは会話を
 * 開いたときだけ）を永久に光らせてしまうので、最後の書き込みからの
 * 経過でも切る。書き込みを伴わないぶん、印は自然に消える。
 *
 * バインドは1つ（この時刻より後に書かれたものだけを生成中とみなす）。
 */
export const GENERATING_CONVERSATIONS_SQL = `SELECT DISTINCT conversation_id AS id
     FROM messages
    WHERE status = 'streaming'
      AND COALESCE(flushed_at, created_at) > ?`;

/**
 * 保管しているものの大きさ（使用量の画面に出す）。
 *
 * 1文にまとめてあるのは、D1 の応答に載る `meta.size_after`（データベース
 * 本体のバイト数）を**同じ往復で**受け取るため。件数を数えるためだけの
 * 問い合わせを増やすより、1回で両方取ったほうがサブリクエストを使わない。
 *
 * R2 の使用量は attachments の記録から出す。R2 には「バケットの合計を
 * 返す」入口が無く、全オブジェクトを列挙すると枚数ぶんの往復になる。
 * 実体はフォークや分岐で共有されるので、r2_key ごとにまとめて数える
 * （行の数で数えると、共有しているぶんを何度も足してしまう）。
 */
export const STORAGE_STATS_SQL = `SELECT
       (SELECT COUNT(*) FROM conversations) AS conversations,
       (SELECT COUNT(*) FROM messages) AS messages,
       (SELECT COUNT(*) FROM usage_events) AS usage_events,
       (SELECT COUNT(*) FROM (SELECT 1 FROM attachments GROUP BY r2_key)) AS files,
       (SELECT COALESCE(SUM(size), 0)
          FROM (SELECT MAX(size) AS size FROM attachments GROUP BY r2_key)) AS file_bytes,
       (SELECT COUNT(*) FROM pending_file_deletions) AS pending_deletions`;

/**
 * 期間の使用量。
 *
 * 本体（db.server.ts）と、SQLite に流して確かめるテストの両方がこれを
 * 使う。手で書き写すと、片方だけ直したときに気づけない。
 *
 * バインドは1つ（この時刻以降）。「額が取れなかった分のポイント」を
 * 別に数えているのは、上限の判定でそこだけ換算レートで見積もるため。
 */
export const USAGE_TOTALS_SQL = `SELECT
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COALESCE(SUM(points), 0) AS points,
         COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN points ELSE 0 END), 0)
           AS points_without_cost,
         COUNT(*) AS events
       FROM usage_events WHERE at >= ?`;

/** モデル別の内訳。バインドは1つ（この時刻以降）。 */
export const USAGE_BY_MODEL_SQL = `SELECT model_id,
              provider,
              COALESCE(SUM(cost_usd), 0) AS cost_usd,
              COALESCE(SUM(points), 0) AS points,
              COUNT(*) AS events
         FROM usage_events WHERE at >= ?
        GROUP BY model_id, provider
        ORDER BY cost_usd DESC, points DESC`;

/**
 * 確定済みの応答を1件積む文。
 *
 * 「成功するまで生成」が成功のたびに使う。本体（db.server.ts）と、
 * SQLite に流して確かめるテストの両方がこれを使う。
 *
 * 未読の印を**ここで**立てるのが肝。生成の確定（finalizeGeneration）に
 * 任せていたときは、1回の依頼で積まれる応答が全部終わるまで印が付かず、
 * 別の画面から見ていると最初の成功が届いたことに気づけなかった。
 * 既に走っている batch へ足すだけなので、往復は増えない。
 */
export function appendAssistantMessageStatements(params: {
  id: string;
  conversationId: string;
  parentId: string;
  modelId: string;
  content: string;
  usageJson: string | null;
  now: number;
}): Statement[] {
  return [
    {
      sql: "INSERT INTO messages (id, conversation_id, parent_id, role, content, model_id, usage_json, status, flushed_at, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?, 'done', ?, ?)",
      binds: [
        params.id,
        params.conversationId,
        params.parentId,
        params.content,
        params.modelId,
        params.usageJson,
        params.now,
        params.now,
      ],
    },
    {
      sql: "UPDATE conversations SET current_leaf_message_id = ?, updated_at = ?, unread = 1 WHERE id = ?",
      binds: [params.id, params.now, params.conversationId],
    },
  ];
}
