import { env } from "cloudflare:workers";

/**
 * Data access layer for D1.
 *
 * Messages form a tree via parent_id (a message may have multiple children,
 * e.g. after regenerating a response). conversations.current_leaf_message_id
 * points at the tip of the currently displayed path.
 *
 * The schema is applied lazily at runtime so no CLI migration step is needed.
 */

/**
 * バージョン管理付きのランタイムマイグレーション。配列に追記していく。
 * 適用済みバージョンは meta テーブルに記録される。
 */
const MIGRATIONS: string[] = [
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
];

let schemaReady: Promise<void> | null = null;

async function runMigrations(): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const row = await env.DB.prepare(
    "SELECT value FROM meta WHERE key = 'schema_version'",
  ).first<{ value: string }>();
  let version = row ? Number(row.value) : 0;

  while (version < MIGRATIONS.length) {
    await env.DB.exec(MIGRATIONS[version].replace(/\n/g, " "));
    version++;
    await env.DB.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
    )
      .bind(String(version))
      .run();
  }
}

async function db(): Promise<D1Database> {
  if (!schemaReady) {
    schemaReady = runMigrations();
  }
  await schemaReady;
  return env.DB;
}

export interface ConversationRow {
  id: string;
  title: string;
  model_id: string | null;
  pinned: number;
  current_leaf_message_id: string | null;
  bot_id: string | null;
  bot_name: string | null;
  bot_icon: string | null;
  system_prompt: string | null;
  params_json: string | null;
  folder_id: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface FolderRow {
  id: string;
  name: string;
  pinned: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface BotRow {
  id: string;
  name: string;
  icon: string;
  model_id: string;
  system_prompt: string;
  params_json: string | null;
  created_at: number;
  updated_at: number;
}

export type MessageStatus = "streaming" | "done" | "error";

export interface MessageRow {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  model_id: string | null;
  usage_json: string | null;
  reasoning: string | null;
  status: MessageStatus;
  error: string | null;
  stop_requested: number;
  /** 生成中の最終フラッシュ時刻。中断検知に使う。 */
  flushed_at: number | null;
  created_at: number;
}

/**
 * 「生成中」のまま一定時間更新がない行を、中断とみなして確定させる。
 * 生成プロセスが不慮に落ちてもUIが永久に固まらないための保険。
 * 対象行は渡された配列内でも書き換えて返す。
 */
const STALE_STREAMING_MS = 60 * 1000;

async function sweepStaleStreaming(rows: MessageRow[]): Promise<void> {
  const now = Date.now();
  const stale = rows.filter(
    (m) =>
      m.status === "streaming" &&
      now - (m.flushed_at ?? m.created_at) > STALE_STREAMING_MS,
  );
  if (stale.length === 0) return;
  const d = await db();
  const statements: D1PreparedStatement[] = [];
  for (const m of stale) {
    if (m.content !== "") {
      m.status = "done";
      m.error = null;
    } else {
      m.status = "error";
      m.error = "生成が中断されました。再試行してください。";
    }
    statements.push(
      d
        .prepare(
          "UPDATE messages SET status = ?, error = ? WHERE id = ? AND status = 'streaming'",
        )
        .bind(m.status, m.error, m.id),
    );
  }
  await d.batch(statements);
}

export async function listConversations(): Promise<ConversationRow[]> {
  const d = await db();
  const { results } = await d
    .prepare(
      "SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC LIMIT 200",
    )
    .all<ConversationRow>();
  return results;
}

export async function getConversation(
  id: string,
): Promise<ConversationRow | null> {
  const d = await db();
  return await d
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .bind(id)
    .first<ConversationRow>();
}

export async function createConversation(params: {
  title: string;
  modelId: string;
  /** ボット開始時はボットの設定をスナップショットして保持する。 */
  bot?: BotRow | null;
}): Promise<ConversationRow> {
  const d = await db();
  const now = Date.now();
  const bot = params.bot ?? null;
  const row: ConversationRow = {
    id: crypto.randomUUID(),
    title: params.title,
    model_id: params.modelId,
    pinned: 0,
    current_leaf_message_id: null,
    bot_id: bot?.id ?? null,
    bot_name: bot?.name ?? null,
    bot_icon: bot?.icon ?? null,
    system_prompt: bot ? bot.system_prompt : null,
    params_json: bot?.params_json ?? null,
    folder_id: null,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  };
  await d
    .prepare(
      "INSERT INTO conversations (id, title, model_id, pinned, current_leaf_message_id, bot_id, bot_name, bot_icon, system_prompt, params_json, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      row.id,
      row.title,
      row.model_id,
      row.bot_id,
      row.bot_name,
      row.bot_icon,
      row.system_prompt,
      row.params_json,
      now,
      now,
    )
    .run();
  return row;
}

export async function updateConversationTitle(
  id: string,
  title: string,
): Promise<void> {
  const d = await db();
  await d
    .prepare("UPDATE conversations SET title = ? WHERE id = ?")
    .bind(title, id)
    .run();
}

export async function updateConversationModel(
  id: string,
  modelId: string,
): Promise<void> {
  const d = await db();
  await d
    .prepare("UPDATE conversations SET model_id = ? WHERE id = ?")
    .bind(modelId, id)
    .run();
}

export async function updateConversationParams(
  id: string,
  paramsJson: string | null,
): Promise<void> {
  const d = await db();
  await d
    .prepare("UPDATE conversations SET params_json = ? WHERE id = ?")
    .bind(paramsJson, id)
    .run();
}

// --- 検索 -----------------------------------------------------------------

export interface SearchResult {
  id: string;
  title: string;
  /** 本文がヒットした場合の抜粋（タイトルのみヒット時は null）。 */
  snippet: string | null;
}

/** LIKE用エスケープ（% _ \ を無効化）。 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 会話検索。スペース区切りの各語について、タイトルまたは本文への
 * 部分一致を要求する（AND）。先頭に "-" を付けた語は除外条件になり、
 * タイトル・本文のどこにも含まれない会話だけがヒットする。
 */
export async function searchConversations(
  query: string,
): Promise<SearchResult[]> {
  const terms = query.split(/[\s　]+/).filter(Boolean);
  const positives = terms.filter((t) => !t.startsWith("-"));
  const negatives = terms
    .filter((t) => t.startsWith("-"))
    .map((t) => t.slice(1))
    .filter(Boolean);
  if (positives.length === 0) return [];

  const d = await db();
  let sql = "SELECT c.id, c.title FROM conversations c WHERE 1=1";
  const binds: string[] = [];
  const matchClause =
    "(c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'))";
  for (const t of positives) {
    sql += ` AND ${matchClause}`;
    const like = `%${escapeLike(t)}%`;
    binds.push(like, like);
  }
  for (const t of negatives) {
    sql += ` AND NOT ${matchClause}`;
    const like = `%${escapeLike(t)}%`;
    binds.push(like, like);
  }
  sql += " ORDER BY c.updated_at DESC LIMIT 50";

  const { results } = await d
    .prepare(sql)
    .bind(...binds)
    .all<{ id: string; title: string }>();

  // 抜粋: 最初の検索語が本文にヒットした位置の前後を切り出す
  const firstLike = `%${escapeLike(positives[0])}%`;
  const out: SearchResult[] = [];
  for (const row of results) {
    const hit = await d
      .prepare(
        "SELECT content FROM messages WHERE conversation_id = ? AND content LIKE ? ESCAPE '\\' LIMIT 1",
      )
      .bind(row.id, firstLike)
      .first<{ content: string }>();
    let snippet: string | null = null;
    if (hit) {
      const idx = hit.content
        .toLowerCase()
        .indexOf(positives[0].toLowerCase());
      const start = Math.max(0, idx - 30);
      snippet =
        (start > 0 ? "…" : "") +
        hit.content.slice(start, start + 90).replace(/\n/g, " ") +
        (start + 90 < hit.content.length ? "…" : "");
    }
    out.push({ id: row.id, title: row.title, snippet });
  }
  return out;
}

// --- Folders / サイドバー整理 ---------------------------------------------

export async function listFolders(): Promise<FolderRow[]> {
  const d = await db();
  const { results } = await d
    .prepare("SELECT * FROM folders ORDER BY sort_order, created_at")
    .all<FolderRow>();
  return results;
}

export async function createFolder(name: string): Promise<FolderRow> {
  const d = await db();
  const now = Date.now();
  const row: FolderRow = {
    id: crypto.randomUUID(),
    name,
    pinned: 0,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  };
  await d
    .prepare(
      "INSERT INTO folders (id, name, pinned, sort_order, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?)",
    )
    .bind(row.id, row.name, now, now)
    .run();
  return row;
}

export async function updateFolder(
  id: string,
  fields: { name?: string; pinned?: boolean },
): Promise<void> {
  const d = await db();
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [Date.now()];
  if (fields.name !== undefined) {
    sets.unshift("name = ?");
    binds.unshift(fields.name);
  }
  if (fields.pinned !== undefined) {
    sets.unshift("pinned = ?");
    binds.unshift(fields.pinned ? 1 : 0);
  }
  binds.push(id);
  await d
    .prepare(`UPDATE folders SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

/** フォルダ削除。中の会話はフォルダなしに戻る（会話自体は消えない）。 */
export async function deleteFolder(id: string): Promise<void> {
  const d = await db();
  await d.batch([
    d.prepare("UPDATE conversations SET folder_id = NULL WHERE folder_id = ?").bind(id),
    d.prepare("DELETE FROM folders WHERE id = ?").bind(id),
  ]);
}

export async function updateConversationMeta(
  id: string,
  fields: { title?: string; pinned?: boolean; folderId?: string | null },
): Promise<void> {
  const d = await db();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (fields.title !== undefined) {
    sets.push("title = ?");
    binds.push(fields.title);
  }
  if (fields.pinned !== undefined) {
    sets.push("pinned = ?");
    binds.push(fields.pinned ? 1 : 0);
  }
  if (fields.folderId !== undefined) {
    sets.push("folder_id = ?");
    binds.push(fields.folderId);
  }
  if (sets.length === 0) return;
  binds.push(id);
  await d
    .prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

/**
 * ピン留め一覧（フォルダ + 会話の混在）の中で項目を上下に移動する。
 * sort_order を 1..n に正規化してから隣と入れ替える。
 */
export async function movePinnedItem(
  type: "conversation" | "folder",
  id: string,
  direction: "up" | "down",
): Promise<void> {
  const d = await db();
  const [folders, conversations] = await Promise.all([
    listFolders(),
    listConversations(),
  ]);
  const items = [
    ...folders.filter((f) => f.pinned).map((f) => ({ type: "folder" as const, row: f })),
    ...conversations.filter((c) => c.pinned).map((c) => ({ type: "conversation" as const, row: c })),
  ].sort(
    (a, b) => a.row.sort_order - b.row.sort_order || a.row.created_at - b.row.created_at,
  );

  const index = items.findIndex((it) => it.type === type && it.row.id === id);
  if (index === -1) return;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= items.length) return;

  [items[index], items[target]] = [items[target], items[index]];

  const statements: D1PreparedStatement[] = [];
  items.forEach((it, i) => {
    const order = i + 1;
    if (it.row.sort_order !== order) {
      statements.push(
        d
          .prepare(
            it.type === "folder"
              ? "UPDATE folders SET sort_order = ? WHERE id = ?"
              : "UPDATE conversations SET sort_order = ? WHERE id = ?",
          )
          .bind(order, it.row.id),
      );
    }
  });
  if (statements.length > 0) await d.batch(statements);
}

// --- Bots -----------------------------------------------------------------

export async function listBots(): Promise<BotRow[]> {
  const d = await db();
  const { results } = await d
    .prepare("SELECT * FROM bots ORDER BY updated_at DESC")
    .all<BotRow>();
  return results;
}

export async function getBot(id: string): Promise<BotRow | null> {
  const d = await db();
  return await d.prepare("SELECT * FROM bots WHERE id = ?").bind(id).first<BotRow>();
}

export async function createBot(params: {
  name: string;
  icon: string;
  modelId: string;
  systemPrompt: string;
  paramsJson: string | null;
}): Promise<BotRow> {
  const d = await db();
  const now = Date.now();
  const row: BotRow = {
    id: crypto.randomUUID(),
    name: params.name,
    icon: params.icon,
    model_id: params.modelId,
    system_prompt: params.systemPrompt,
    params_json: params.paramsJson,
    created_at: now,
    updated_at: now,
  };
  await d
    .prepare(
      "INSERT INTO bots (id, name, icon, model_id, system_prompt, params_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(row.id, row.name, row.icon, row.model_id, row.system_prompt, row.params_json, now, now)
    .run();
  return row;
}

export async function updateBot(
  id: string,
  params: {
    name: string;
    icon: string;
    modelId: string;
    systemPrompt: string;
    paramsJson: string | null;
  },
): Promise<void> {
  const d = await db();
  await d
    .prepare(
      "UPDATE bots SET name = ?, icon = ?, model_id = ?, system_prompt = ?, params_json = ?, updated_at = ? WHERE id = ?",
    )
    .bind(
      params.name,
      params.icon,
      params.modelId,
      params.systemPrompt,
      params.paramsJson,
      Date.now(),
      id,
    )
    .run();
}

export async function deleteBot(id: string): Promise<void> {
  const d = await db();
  await d.prepare("DELETE FROM bots WHERE id = ?").bind(id).run();
}

export async function deleteConversation(id: string): Promise<void> {
  const d = await db();
  await d.batch([
    d.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
    d.prepare("DELETE FROM conversations WHERE id = ?").bind(id),
  ]);
}

export interface PathMessage extends MessageRow {
  /** 同じ親を持つ兄弟（自分含む、作成順）。 */
  sibling_ids: string[];
  sibling_index: number;
}

async function loadMessages(conversationId: string): Promise<MessageRow[]> {
  const d = await db();
  const { results } = await d
    .prepare("SELECT * FROM messages WHERE conversation_id = ?")
    .bind(conversationId)
    .all<MessageRow>();
  return results;
}

function childrenByParent(all: MessageRow[]): Map<string | null, MessageRow[]> {
  const map = new Map<string | null, MessageRow[]>();
  for (const m of all) {
    const list = map.get(m.parent_id) ?? [];
    list.push(m);
    map.set(m.parent_id, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.created_at - b.created_at);
  }
  return map;
}

/**
 * Returns the messages on the currently displayed path (root ->
 * current_leaf) in display order, each annotated with its siblings so the
 * UI can render branch pagers.
 */
export async function getConversationPath(
  conversation: ConversationRow,
): Promise<PathMessage[]> {
  if (!conversation.current_leaf_message_id) return [];
  const all = await loadMessages(conversation.id);
  await sweepStaleStreaming(all);
  const byId = new Map(all.map((m) => [m.id, m]));
  const children = childrenByParent(all);

  const path: PathMessage[] = [];
  let cursor = byId.get(conversation.current_leaf_message_id);
  while (cursor) {
    const current = cursor;
    const siblings = children.get(current.parent_id) ?? [current];
    path.push({
      ...current,
      sibling_ids: siblings.map((s) => s.id),
      sibling_index: siblings.findIndex((s) => s.id === current.id),
    });
    cursor = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path.reverse();
}

/**
 * Moves the conversation's current leaf to the given message's subtree,
 * descending to the most recently created descendant. Used when switching
 * branches. Returns false when the message doesn't belong to the
 * conversation.
 */
export async function switchToBranch(
  conversation: ConversationRow,
  messageId: string,
): Promise<boolean> {
  const all = await loadMessages(conversation.id);
  if (!all.some((m) => m.id === messageId)) return false;
  const children = childrenByParent(all);

  let leafId = messageId;
  for (;;) {
    const kids = children.get(leafId);
    if (!kids || kids.length === 0) break;
    leafId = kids[kids.length - 1].id; // 最新の子を辿る
  }

  const d = await db();
  await d
    .prepare("UPDATE conversations SET current_leaf_message_id = ? WHERE id = ?")
    .bind(leafId, conversation.id)
    .run();
  return true;
}

/**
 * Copies the path (root -> messageId) into a brand-new conversation.
 * Sibling branches are not copied. Returns the new conversation's id, or
 * null when the message doesn't belong to the conversation.
 */
export async function forkConversation(
  conversation: ConversationRow,
  messageId: string,
): Promise<string | null> {
  const all = await loadMessages(conversation.id);
  const byId = new Map(all.map((m) => [m.id, m]));
  if (!byId.has(messageId)) return null;

  const path: MessageRow[] = [];
  let cursor = byId.get(messageId);
  while (cursor) {
    path.push(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  path.reverse();

  const d = await db();
  const now = Date.now();
  const newConvId = crypto.randomUUID();
  const title = `${conversation.title}（分岐）`.slice(0, 60);

  const statements: D1PreparedStatement[] = [
    d
      .prepare(
        "INSERT INTO conversations (id, title, model_id, pinned, current_leaf_message_id, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, ?, ?)",
      )
      .bind(newConvId, title, conversation.model_id, now, now),
  ];

  let parent: string | null = null;
  let lastId: string | null = null;
  for (const [i, m] of path.entries()) {
    const id = crypto.randomUUID();
    statements.push(
      d
        .prepare(
          "INSERT INTO messages (id, conversation_id, parent_id, role, content, model_id, usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id, newConvId, parent, m.role, m.content, m.model_id, m.usage_json, now + i),
    );
    parent = id;
    lastId = id;
  }
  statements.push(
    d
      .prepare("UPDATE conversations SET current_leaf_message_id = ? WHERE id = ?")
      .bind(lastId, newConvId),
  );

  await d.batch(statements);
  return newConvId;
}

// --- サーバー側生成 -------------------------------------------------------

/**
 * 生成開始時の書き込み: ユーザーメッセージ（あれば）と、生成中ステータスの
 * アシスタントプレースホルダを親の下に挿入し、リーフを移動する。
 */
export async function beginGeneration(params: {
  conversationId: string;
  parentId: string | null;
  userContent: string | null;
  modelId: string;
}): Promise<{ userMessageId: string | null; assistantMessageId: string }> {
  const d = await db();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  let parent = params.parentId;
  let userMessageId: string | null = null;
  if (params.userContent != null) {
    userMessageId = crypto.randomUUID();
    statements.push(
      d
        .prepare(
          "INSERT INTO messages (id, conversation_id, parent_id, role, content, status, created_at) VALUES (?, ?, ?, 'user', ?, 'done', ?)",
        )
        .bind(userMessageId, params.conversationId, parent, params.userContent, now),
    );
    parent = userMessageId;
  }

  const assistantMessageId = crypto.randomUUID();
  statements.push(
    d
      .prepare(
        "INSERT INTO messages (id, conversation_id, parent_id, role, content, model_id, status, flushed_at, created_at) VALUES (?, ?, ?, 'assistant', '', ?, 'streaming', ?, ?)",
      )
      .bind(assistantMessageId, params.conversationId, parent, params.modelId, now, now + 1),
  );
  statements.push(
    d
      .prepare(
        "UPDATE conversations SET current_leaf_message_id = ?, updated_at = ? WHERE id = ?",
      )
      .bind(assistantMessageId, now, params.conversationId),
  );

  await d.batch(statements);
  return { userMessageId, assistantMessageId };
}

/**
 * 生成中の部分保存。停止要求が入っていれば true を返す。
 */
export async function flushGeneration(
  messageId: string,
  partial: { content: string; reasoning: string | null },
): Promise<{ stopRequested: boolean }> {
  const d = await db();
  await d
    .prepare(
      "UPDATE messages SET content = ?, reasoning = ?, flushed_at = ? WHERE id = ? AND status = 'streaming'",
    )
    .bind(partial.content, partial.reasoning, Date.now(), messageId)
    .run();
  const row = await d
    .prepare("SELECT stop_requested FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ stop_requested: number }>();
  return { stopRequested: (row?.stop_requested ?? 0) === 1 };
}

/** 生成の完了・エラー・停止を確定させる。 */
export async function finalizeGeneration(
  messageId: string,
  result: {
    content: string;
    reasoning: string | null;
    usageJson: string | null;
    status: "done" | "error";
    error?: string | null;
  },
): Promise<void> {
  const d = await db();
  await d
    .prepare(
      "UPDATE messages SET content = ?, reasoning = ?, usage_json = ?, status = ?, error = ?, flushed_at = ? WHERE id = ?",
    )
    .bind(
      result.content,
      result.reasoning,
      result.usageJson,
      result.status,
      result.error ?? null,
      Date.now(),
      messageId,
    )
    .run();
}

/** 生成停止を要求する（次のフラッシュ時に生成側が検知する）。 */
export async function requestStop(
  conversationId: string,
  messageId: string,
): Promise<void> {
  const d = await db();
  await d
    .prepare(
      "UPDATE messages SET stop_requested = 1 WHERE id = ? AND conversation_id = ? AND status = 'streaming'",
    )
    .bind(messageId, conversationId)
    .run();
}

/**
 * メッセージの一括削除。削除ノードはツリーから「抜き取り」、
 * その子は最も近い生き残りの祖先へ繋ぎ直す（前後の会話は保たれる）。
 * 表示中リーフが削除された場合は生き残りの祖先へ移動する。
 */
export async function deleteMessages(
  conversationId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const conversation = await getConversation(conversationId);
  if (!conversation) return;
  const all = await loadMessages(conversationId);
  const byId = new Map(all.map((m) => [m.id, m]));
  const deleteSet = new Set(ids.filter((id) => byId.has(id)));
  if (deleteSet.size === 0) return;

  // 最も近い「削除されない」祖先を探す
  const surviveParent = (startParentId: string | null): string | null => {
    let cursor = startParentId;
    while (cursor && deleteSet.has(cursor)) {
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
    return cursor;
  };

  const d = await db();
  const statements: D1PreparedStatement[] = [];

  // 生き残る子の親を繋ぎ直す
  for (const m of all) {
    if (deleteSet.has(m.id)) continue;
    if (m.parent_id && deleteSet.has(m.parent_id)) {
      statements.push(
        d
          .prepare("UPDATE messages SET parent_id = ? WHERE id = ?")
          .bind(surviveParent(m.parent_id), m.id),
      );
    }
  }

  // リーフの付け替え
  const leafId = conversation.current_leaf_message_id;
  if (leafId && deleteSet.has(leafId)) {
    const newLeaf = surviveParent(byId.get(leafId)?.parent_id ?? null);
    statements.push(
      d
        .prepare(
          "UPDATE conversations SET current_leaf_message_id = ? WHERE id = ?",
        )
        .bind(newLeaf, conversationId),
    );
  }

  for (const id of deleteSet) {
    statements.push(d.prepare("DELETE FROM messages WHERE id = ?").bind(id));
  }

  await d.batch(statements);
}

/** ポーリング用: 単一メッセージの現在状態を返す（中断検知つき）。 */
export async function getMessage(
  conversationId: string,
  messageId: string,
): Promise<MessageRow | null> {
  const d = await db();
  const row = await d
    .prepare("SELECT * FROM messages WHERE id = ? AND conversation_id = ?")
    .bind(messageId, conversationId)
    .first<MessageRow>();
  if (row) await sweepStaleStreaming([row]);
  return row;
}

