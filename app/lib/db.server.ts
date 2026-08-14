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

const SCHEMA = `
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
`;

let schemaReady: Promise<void> | null = null;

async function db(): Promise<D1Database> {
  if (!schemaReady) {
    schemaReady = env.DB.exec(SCHEMA.replace(/\n/g, " ")).then(() => {});
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
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  model_id: string | null;
  usage_json: string | null;
  created_at: number;
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
}): Promise<ConversationRow> {
  const d = await db();
  const now = Date.now();
  const row: ConversationRow = {
    id: crypto.randomUUID(),
    title: params.title,
    model_id: params.modelId,
    pinned: 0,
    current_leaf_message_id: null,
    created_at: now,
    updated_at: now,
  };
  await d
    .prepare(
      "INSERT INTO conversations (id, title, model_id, pinned, current_leaf_message_id, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, ?, ?)",
    )
    .bind(row.id, row.title, row.model_id, now, now)
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

export async function deleteConversation(id: string): Promise<void> {
  const d = await db();
  await d.batch([
    d.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
    d.prepare("DELETE FROM conversations WHERE id = ?").bind(id),
  ]);
}

/**
 * Returns the messages on the currently displayed path (root ->
 * current_leaf), in display order.
 */
export async function getConversationPath(
  conversation: ConversationRow,
): Promise<MessageRow[]> {
  if (!conversation.current_leaf_message_id) return [];
  const d = await db();
  const { results } = await d
    .prepare("SELECT * FROM messages WHERE conversation_id = ?")
    .bind(conversation.id)
    .all<MessageRow>();

  const byId = new Map(results.map((m) => [m.id, m]));
  const path: MessageRow[] = [];
  let cursor = byId.get(conversation.current_leaf_message_id);
  while (cursor) {
    path.push(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return path.reverse();
}

export interface NewMessage {
  role: "user" | "assistant" | "system";
  content: string;
  modelId?: string;
  usageJson?: string;
}

/**
 * Appends a chain of messages under parentId (null = new root) and moves the
 * conversation's current leaf to the last appended message. Returns the new
 * message IDs in order.
 */
export async function appendMessages(params: {
  conversationId: string;
  parentId: string | null;
  messages: NewMessage[];
}): Promise<string[]> {
  if (params.messages.length === 0) return [];
  const d = await db();
  const now = Date.now();

  const ids: string[] = [];
  const statements: D1PreparedStatement[] = [];
  let parent = params.parentId;
  for (const [i, m] of params.messages.entries()) {
    const id = crypto.randomUUID();
    ids.push(id);
    statements.push(
      d
        .prepare(
          "INSERT INTO messages (id, conversation_id, parent_id, role, content, model_id, usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          id,
          params.conversationId,
          parent,
          m.role,
          m.content,
          m.modelId ?? null,
          m.usageJson ?? null,
          now + i,
        ),
    );
    parent = id;
  }
  statements.push(
    d
      .prepare(
        "UPDATE conversations SET current_leaf_message_id = ?, updated_at = ? WHERE id = ?",
      )
      .bind(ids[ids.length - 1], now, params.conversationId),
  );

  await d.batch(statements);
  return ids;
}
