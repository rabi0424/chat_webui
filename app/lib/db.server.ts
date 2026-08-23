import { env } from "cloudflare:workers";
import { deleteFiles } from "./r2.server";
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_SYSTEM_PROMPT_MAX,
  MONTHLY_LIMIT_RANGE,
  conversationSystemPrompt,
  NEW_MODEL_DAYS_RANGE,
  POE_RATE_RANGE,
  RETRY_CEILING_RANGE,
  type AppSettings,
} from "./settings";
import { MAX_TITLE_LENGTH, POE_PREFIX } from "./constants";
import {
  CONVERSATIONS_LATEST_SQL,
  DUE_PENDING_DELETIONS_SQL,
  INSERT_USER_MESSAGE_SQL,
  appendAssistantMessageStatements,
  GENERATING_CONVERSATIONS_SQL,
  MIGRATIONS,
  PENDING_DELETION_GRACE_MS,
  QUEUE_PENDING_DELETION_SQL,
  STALE_STREAMING_MS,
  STORAGE_STATS_SQL,
  USAGE_BY_MODEL_SQL,
  USAGE_TOTALS_SQL,
  clearPendingDeletionsSql,
  generatedImagesSql,
  statementsOf,
  stillReferencedSql,
  undoGenerationStatements,
} from "./schema";
import {
  EMPTY_TOTALS,
  USAGE_RANGES,
  usageRangeStart,
  type UsageRange,
  type UsageTotals,
} from "./usage";

/**
 * Data access layer for D1.
 *
 * Messages form a tree via parent_id (a message may have multiple children,
 * e.g. after regenerating a response). conversations.current_leaf_message_id
 * points at the tip of the currently displayed path.
 *
 * The schema is applied lazily at runtime so no CLI migration step is needed.
 */

let schemaReady: Promise<void> | null = null;

/**
 * 既に適用済みの列を足そうとしたときのエラーか。
 *
 * ALTER TABLE ADD COLUMN だけは何度でも実行できる形（IF NOT EXISTS）が
 * SQLite に無いため、二重適用のエラーだけを成功とみなして読み飛ばす。
 * これでマイグレーション全体が「途中まで適用された状態から流し直せる」
 * ものになり、次の2つがどちらも安全になる:
 *
 * - 複数の isolate が同時に初回アクセスして同じ版を適用してしまう場合
 * - 1つの版の途中で失敗し、版番号を記録できないまま再実行される場合
 */
function isDuplicateColumn(e: unknown): boolean {
  return /duplicate column name/i.test((e as Error)?.message ?? "");
}

async function runMigrations(): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const row = await env.DB.prepare(
    "SELECT value FROM meta WHERE key = 'schema_version'",
  ).first<{ value: string }>();
  const recorded = row ? Number(row.value) : 0;
  if (!Number.isInteger(recorded) || recorded < 0) {
    // 版番号が読めないまま先へ進むと、適用漏れに気づけないまま
    // 後続のクエリが不可解に失敗する。ここで止めた方が原因が分かる
    throw new Error(`schema_version が壊れています: ${row?.value}`);
  }
  let version = recorded;

  while (version < MIGRATIONS.length) {
    for (const statement of statementsOf(MIGRATIONS[version])) {
      try {
        await env.DB.exec(statement.replace(/\n/g, " "));
      } catch (e) {
        if (!isDuplicateColumn(e)) throw e;
      }
    }
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
    // 失敗した Promise を握ったままにすると、D1の一時障害のあと
    // その isolate だけが延々と同じ失敗を返し続ける。捨てて次で引き直す
    schemaReady = runMigrations().catch((e) => {
      schemaReady = null;
      throw e;
    });
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
  /** 応答が完成したがまだ開いていない会話は 1。 */
  unread: number;
  /** お気に入り。ピン留めとは別で、常設の「お気に入り」フォルダに集まる。 */
  favorite: number;
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
  /** 1 = この直後にコンテキストの境界線がある（ここまでは以後送らない）。 */
  context_boundary: number;
  /** 参照元（url_citation）の配列をJSONにしたもの。無ければ null。 */
  citations_json: string | null;
  created_at: number;
}

const APP_SETTINGS_KEY = "app_settings";

export async function getAppSettings(): Promise<AppSettings> {
  const d = await db();
  const row = await d
    .prepare("SELECT value FROM meta WHERE key = ?")
    .bind(APP_SETTINGS_KEY)
    .first<{ value: string }>();
  if (!row) return { ...DEFAULT_APP_SETTINGS };
  try {
    const parsed = JSON.parse(row.value) as Partial<AppSettings>;
    return { ...DEFAULT_APP_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

/** 渡された項目だけを更新する。不正値は現在値のまま。 */
export async function updateAppSettings(
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const current = await getAppSettings();
  const next = { ...current };

  const ceiling = Number(patch.retryAttemptCeiling);
  if (Number.isFinite(ceiling)) {
    next.retryAttemptCeiling = Math.min(
      Math.max(Math.round(ceiling), RETRY_CEILING_RANGE.min),
      RETRY_CEILING_RANGE.max,
    );
  }

  const days = Number(patch.newModelDays);
  if (Number.isFinite(days)) {
    next.newModelDays = Math.min(
      Math.max(Math.round(days), NEW_MODEL_DAYS_RANGE.min),
      NEW_MODEL_DAYS_RANGE.max,
    );
  }

  const limit = Number(patch.monthlyLimitJpy);
  if (Number.isFinite(limit)) {
    next.monthlyLimitJpy = Math.min(
      Math.max(Math.round(limit), MONTHLY_LIMIT_RANGE.min),
      MONTHLY_LIMIT_RANGE.max,
    );
  }

  if ("defaultModelId" in patch) {
    const id = patch.defaultModelId;
    // 空文字は「指定なし」として扱う（入力欄を空にしたときに
    // 存在しないIDが残らないように）
    next.defaultModelId =
      typeof id === "string" && id.trim() !== "" ? id.trim() : null;
  }

  if (typeof patch.defaultSystemPrompt === "string") {
    next.defaultSystemPrompt = patch.defaultSystemPrompt.slice(
      0,
      DEFAULT_SYSTEM_PROMPT_MAX,
    );
  }

  if (patch.defaultParams && typeof patch.defaultParams === "object") {
    next.defaultParams = patch.defaultParams;
  }

  const rate = Number(patch.poePointsUsdRate);
  if (Number.isFinite(rate)) {
    next.poePointsUsdRate = Math.min(
      Math.max(rate, POE_RATE_RANGE.min),
      POE_RATE_RANGE.max,
    );
  }

  // 一時解除は「どの月か」で持つ。true/false のトグルにすると、
  // 解除したまま忘れて翌月も素通りする
  if ("monthlyLimitOverride" in patch) {
    const v = patch.monthlyLimitOverride;
    next.monthlyLimitOverride =
      typeof v === "string" && /^\d{4}-\d{2}$/.test(v) ? v : null;
  }

  const d = await db();
  await d
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
    )
    .bind(APP_SETTINGS_KEY, JSON.stringify(next))
    .run();
  return next;
}

export interface AttachmentRow {
  id: string;
  /** アップロード直後は NULL。送信時にユーザーメッセージへ紐づく。 */
  message_id: string | null;
  conversation_id: string | null;
  r2_key: string;
  mime_type: string;
  name: string | null;
  size: number;
  created_at: number;
  /** upload = ユーザーが添付した画像 / generated = モデルが生成した画像。 */
  kind: "upload" | "generated";
  favorite: number;
  /** 生成画像のみ。生成時の依頼文（検索用の写し）。 */
  prompt: string | null;
}

/**
 * 「生成中」のまま一定時間更新がない行を、中断とみなして確定させる。
 * 生成プロセスが不慮に落ちてもUIが永久に固まらないための保険。
 * 対象行は渡された配列内でも書き換えて返す。
 *
 * しきい値（STALE_STREAMING_MS）は schema.ts に置いて、サイドバーが
 * 「生成中」を判定するSQLと同じ値を使う。
 */
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
  /*
   * ボットを使わない会話にも、アプリ既定のシステムプロンプトを写し取る。
   * 参照ではなく写しにするのは、あとで既定を変えたときに既にある会話の
   * 前提が入れ替わらないようにするため（ボットと同じ規則）。
   */
  const systemPrompt = conversationSystemPrompt(bot, await getAppSettings());
  const row: ConversationRow = {
    id: crypto.randomUUID(),
    title: params.title,
    model_id: params.modelId,
    pinned: 0,
    current_leaf_message_id: null,
    bot_id: bot?.id ?? null,
    bot_name: bot?.name ?? null,
    bot_icon: bot?.icon ?? null,
    unread: 0,
    favorite: 0,
    system_prompt: systemPrompt,
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

/**
 * 一度の検索で見る語の数。1語あたりバインドを2つ使うので、
 * D1の上限（1文あたり100個）に十分収まる数にする。
 */
const MAX_SEARCH_TERMS = 10;

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
  /*
   * 語数に上限を設ける。1語につきバインドを2つ（タイトル・本文）使うので、
   * 語が増えるとD1の上限（1文あたり100個）に当たって検索が500になる。
   * 1文字の語ばかりを並べれば現実に届く数なので、ここで切っておく。
   */
  const terms = query
    .split(/[\s　]+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TERMS);
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

/** 更新できたかを返す（存在しないIDへの更新を、成功として返さないため）。 */
export async function updateFolder(
  id: string,
  fields: { name?: string; pinned?: boolean },
): Promise<boolean> {
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
  const res = await d
    .prepare(`UPDATE folders SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return (res.meta.changes ?? 0) > 0;
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
  fields: {
    title?: string;
    pinned?: boolean;
    favorite?: boolean;
    folderId?: string | null;
  },
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
  if (fields.favorite !== undefined) {
    sets.push("favorite = ?");
    binds.push(fields.favorite ? 1 : 0);
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

/**
 * ボット一覧。作成順（古い順）で、新しいものは後ろに足される。
 * 更新順にすると編集のたびに並びが変わり、選ぶ位置を覚えられない。
 */
export async function listBots(): Promise<BotRow[]> {
  const d = await db();
  const { results } = await d
    .prepare("SELECT * FROM bots ORDER BY created_at, id")
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

/**
 * 会話を、ぶら下がるメッセージ・添付ごと削除する。
 *
 * 行はまとめて1回の batch で消す。添付だけ先に消していると、後続の
 * 削除が失敗したときに「会話は残っているのに画像だけ全滅」した状態が
 * 残り、やり直す手立ても無かった。R2の実体は行が消えたあとに片づける
 * （消し損ねても孤児として後から掃除できるが、逆は取り返しがつかない）。
 */
export async function deleteConversation(id: string): Promise<void> {
  const d = await db();
  const { results } = await d
    .prepare("SELECT r2_key FROM attachments WHERE conversation_id = ?")
    .bind(id)
    .all<{ r2_key: string }>();
  await d.batch([
    d.prepare("DELETE FROM attachments WHERE conversation_id = ?").bind(id),
    d.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
    d.prepare("DELETE FROM conversations WHERE id = ?").bind(id),
  ]);
  await notePossiblyUnreferenced([...new Set(results.map((r) => r.r2_key))]);
}

export interface PathMessage extends MessageRow {
  /** 同じ親を持つ兄弟（自分含む、作成順）。 */
  sibling_ids: string[];
  sibling_index: number;
  /** このメッセージに添付された画像（作成順）。 */
  attachments: AttachmentRow[];
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
/** current_leaf からルートまで遡り、表示順（古→新）に並べる。 */
function pathRows(
  conversation: ConversationRow,
  all: MessageRow[],
): MessageRow[] {
  if (!conversation.current_leaf_message_id) return [];
  const byId = new Map(all.map((m) => [m.id, m]));
  const rows: MessageRow[] = [];
  let cursor = byId.get(conversation.current_leaf_message_id);
  while (cursor) {
    rows.push(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return rows.reverse();
}

/** 道筋の各行に兄弟情報と添付を付ける。 */
function decoratePath(
  rows: MessageRow[],
  all: MessageRow[],
  attachments: Map<string, AttachmentRow[]>,
): PathMessage[] {
  const children = childrenByParent(all);
  return rows.map((current) => {
    const siblings = children.get(current.parent_id) ?? [current];
    return {
      ...current,
      sibling_ids: siblings.map((s) => s.id),
      sibling_index: siblings.findIndex((s) => s.id === current.id),
      attachments: attachments.get(current.id) ?? [],
    };
  });
}

export async function getConversationPath(
  conversation: ConversationRow,
): Promise<PathMessage[]> {
  if (!conversation.current_leaf_message_id) return [];
  const all = await loadMessages(conversation.id);
  await sweepStaleStreaming(all);
  const rows = pathRows(conversation, all);
  const attachments = await attachmentsOfConversation(conversation.id);
  return decoratePath(rows, all, attachments);
}

/**
 * 会話・メッセージ・添付を1回のbatchでまとめて読む画面表示用の入口。
 * 個別に読むと Worker ↔ D1 の往復が直列に3回並び、そのぶんページ遷移が
 * 遅くなるため、chat/:id のローダーはこちらを使う。
 * 添付はIN句ではなくJOINで引く（D1のバインド上限100に届かないように）。
 */
export async function getConversationWithPath(
  id: string,
): Promise<{ conversation: ConversationRow; path: PathMessage[] } | null> {
  const d = await db();
  const [convRes, msgRes, attRes] = await d.batch([
    d.prepare("SELECT * FROM conversations WHERE id = ?").bind(id),
    d.prepare("SELECT * FROM messages WHERE conversation_id = ?").bind(id),
    d
      .prepare(
        "SELECT a.* FROM attachments a JOIN messages m ON a.message_id = m.id WHERE m.conversation_id = ? ORDER BY a.created_at",
      )
      .bind(id),
  ]);
  const conversation =
    (convRes.results as unknown as ConversationRow[])[0] ?? null;
  if (!conversation) return null;
  const all = msgRes.results as unknown as MessageRow[];
  // 中断されたストリーミング行が残っていたときだけ、もう1往復して直す
  await sweepStaleStreaming(all);
  const attachments = groupByMessage(
    attRes.results as unknown as AttachmentRow[],
  );
  return {
    conversation,
    path: decoratePath(pathRows(conversation, all), all, attachments),
  };
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
  const title = `${conversation.title}（分岐）`.slice(0, MAX_TITLE_LENGTH);

  const statements: D1PreparedStatement[] = [
    // ボット・システムプロンプト・生成パラメータも引き継ぐ。落とすと、
    // ボットの会話を分岐した先だけ性格と設定が消えて応答が変わる
    d
      .prepare(
        "INSERT INTO conversations (id, title, model_id, pinned, current_leaf_message_id, bot_id, bot_name, bot_icon, system_prompt, params_json, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        newConvId,
        title,
        conversation.model_id,
        conversation.bot_id,
        conversation.bot_name,
        conversation.bot_icon,
        conversation.system_prompt,
        conversation.params_json,
        now,
        now,
      ),
  ];

  const attachments = await attachmentsOfConversation(conversation.id);

  let parent: string | null = null;
  let lastId: string | null = null;
  for (const [i, m] of path.entries()) {
    const id = crypto.randomUUID();
    statements.push(
      d
        .prepare(
          "INSERT INTO messages (id, conversation_id, parent_id, role, content, model_id, usage_json, reasoning, citations_json, status, error, context_boundary, created_at, flushed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          id,
          newConvId,
          parent,
          m.role,
          m.content,
          m.model_id,
          m.usage_json,
          // 思考・参照元も引き継ぐ（分岐先で折りたたみや出典が消えないように）
          m.reasoning,
          m.citations_json,
          // 生成中の行は分岐先では追えないので、確定した形で持っていく。
          // 既定の 'done' で写すと、失敗した応答が成功として複製される
          m.status === "streaming" ? "error" : (m.status ?? "done"),
          m.status === "streaming"
            ? "分岐元で生成中だった応答です。再試行してください。"
            : m.error,
          // コンテキストの境界線も引き継ぐ（分岐先だけ文脈が伸びるのを防ぐ）
          m.context_boundary ?? 0,
          now + i,
          m.flushed_at,
        ),
    );
    // 添付はR2の実体を共有したまま行だけ複製する（元の会話を消しても残る）
    statements.push(
      ...linkAttachmentStatements(d, attachments.get(m.id) ?? [], {
        messageId: id,
        conversationId: newConvId,
      }),
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

// --- 添付ファイル ---------------------------------------------------------

/** アップロード直後の添付を登録する（まだメッセージには属さない）。 */
export async function createAttachment(params: {
  r2Key: string;
  mimeType: string;
  name: string | null;
  size: number;
}): Promise<AttachmentRow> {
  const d = await db();
  const row: AttachmentRow = {
    id: crypto.randomUUID(),
    message_id: null,
    conversation_id: null,
    r2_key: params.r2Key,
    mime_type: params.mimeType,
    name: params.name,
    size: params.size,
    created_at: Date.now(),
    kind: "upload",
    favorite: 0,
    prompt: null,
  };
  await d
    .prepare(
      "INSERT INTO attachments (id, message_id, conversation_id, r2_key, mime_type, name, size, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?)",
    )
    .bind(row.id, row.r2_key, row.mime_type, row.name, row.size, row.created_at)
    .run();
  return row;
}

export async function getAttachment(id: string): Promise<AttachmentRow | null> {
  const d = await db();
  return await d
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .bind(id)
    .first<AttachmentRow>();
}

/**
 * IN句に並べるIDの上限。D1は1文あたりのバインドを100個までしか受けない。
 * 超えると文が丸ごと失敗するので、この単位に切って複数回に分けて引く。
 */
const BIND_CHUNK = 90;

function chunked<T>(items: T[], size = BIND_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** 指定IDの添付を、渡されたID順（= 表示順）で返す。 */
export async function getAttachments(ids: string[]): Promise<AttachmentRow[]> {
  if (ids.length === 0) return [];
  const d = await db();
  const rows: AttachmentRow[] = [];
  for (const part of chunked(ids)) {
    const { results } = await d
      .prepare(
        `SELECT * FROM attachments WHERE id IN (${part
          .map(() => "?")
          .join(",")})`,
      )
      .bind(...part)
      .all<AttachmentRow>();
    rows.push(...results);
  }
  const byId = new Map(rows.map((a) => [a.id, a]));
  return ids
    .map((id) => byId.get(id))
    .filter((a): a is AttachmentRow => a != null);
}

/** 指定メッセージ群の添付を、メッセージIDごとにまとめて返す。 */
function groupByMessage(rows: AttachmentRow[]): Map<string, AttachmentRow[]> {
  const map = new Map<string, AttachmentRow[]>();
  for (const a of rows) {
    if (!a.message_id) continue;
    const list = map.get(a.message_id) ?? [];
    list.push(a);
    map.set(a.message_id, list);
  }
  return map;
}

/**
 * 会話に属する添付を、メッセージIDごとにまとめて返す。
 *
 * メッセージIDのIN句では引かない。表示パスが100件を超えるとD1のバインド
 * 上限に当たって会話そのものが開けなくなるため、getConversationWithPath と
 * 同じくJOINで会話ぶんをまとめて引き、呼び出し側が必要な行だけ取り出す。
 */
async function attachmentsOfConversation(
  conversationId: string,
): Promise<Map<string, AttachmentRow[]>> {
  const d = await db();
  const { results } = await d
    .prepare(
      "SELECT a.* FROM attachments a JOIN messages m ON a.message_id = m.id WHERE m.conversation_id = ? ORDER BY a.created_at",
    )
    .bind(conversationId)
    .all<AttachmentRow>();
  return groupByMessage(results);
}

/**
 * 添付をメッセージへ紐づける文を組み立てる。
 *
 * 未使用の添付（アップロード直後）はそのまま紐づけ、既に別のメッセージに
 * 属している添付は行を複製する。編集して再送信・分岐で同じ画像を引き継いでも、
 * 元のメッセージから添付が奪われないようにするため。
 * R2の実体は複数行で共有され、参照が0になったときだけ削除される。
 */
function linkAttachmentStatements(
  d: D1Database,
  rows: AttachmentRow[],
  target: { messageId: string; conversationId: string },
): D1PreparedStatement[] {
  const now = Date.now();
  return rows.map((a, i) =>
    a.message_id === null
      ? d
          .prepare(
            "UPDATE attachments SET message_id = ?, conversation_id = ?, created_at = ? WHERE id = ? AND message_id IS NULL",
          )
          .bind(target.messageId, target.conversationId, now + i, a.id)
      : d
          .prepare(
            // prompt と favorite も複製する。落とすと、画像一覧は同じ実体の
            // うち最も新しい行（＝この複製）を代表として出すため、
            // 一覧から依頼文が消え、お気に入りも外れて見える
            "INSERT INTO attachments (id, message_id, conversation_id, r2_key, mime_type, name, size, created_at, kind, prompt, favorite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            crypto.randomUUID(),
            target.messageId,
            target.conversationId,
            a.r2_key,
            a.mime_type,
            a.name,
            a.size,
            now + i,
            a.kind ?? "upload",
            a.prompt ?? null,
            a.favorite ?? 0,
          ),
  );
}

/**
 * モデルが生成した画像を添付として登録する。
 * アップロードと違い、最初からメッセージに属する。
 */
export async function createGeneratedAttachment(params: {
  messageId: string;
  conversationId: string;
  r2Key: string;
  mimeType: string;
  name: string | null;
  size: number;
  /** 生成時の依頼文。画像一覧の検索に使う。 */
  prompt?: string | null;
}): Promise<string> {
  const d = await db();
  const id = crypto.randomUUID();
  await d
    .prepare(
      "INSERT INTO attachments (id, message_id, conversation_id, r2_key, mime_type, name, size, created_at, kind, prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generated', ?)",
    )
    .bind(
      id,
      params.messageId,
      params.conversationId,
      params.r2Key,
      params.mimeType,
      params.name,
      params.size,
      Date.now(),
      params.prompt?.slice(0, 2000) ?? null,
    )
    .run();
  return id;
}

/** お気に入りの切り替え。実体を共有する行（フォーク先）もまとめて揃える。 */
/** 更新できたかを返す（存在しないIDへの更新を、成功として返さないため）。 */
export async function setImageFavorite(
  id: string,
  favorite: boolean,
): Promise<boolean> {
  const d = await db();
  const res = await d
    .prepare(
      "UPDATE attachments SET favorite = ? WHERE r2_key = (SELECT r2_key FROM attachments WHERE id = ?)",
    )
    .bind(favorite ? 1 : 0, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export interface GeneratedImageRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  created_at: number;
  favorite: number;
  /** 生成時の依頼文（検索・一覧の説明に使う）。 */
  prompt: string | null;
  /** 生成元の会話タイトル（会話が消えていれば null）。 */
  title: string | null;
  /** 生成に使ったモデル。 */
  model_id: string | null;
}

/**
 * 生成画像の一覧（新しい順）。
 *
 * 会話ツリーの現在のパスとは無関係に、行が存在する限り出す。
 * 再生成や分岐で表示から外れた画像も残り続ける（分岐は上書きではなく
 * 別の枝として保存されるため、元のメッセージの添付は消えない）。
 *
 * 検索は依頼文・モデル名・会話タイトルを対象に、空白区切りの語をANDで見る。
 */
export async function listGeneratedImages(params: {
  limit: number;
  before?: number;
  query?: string;
  favoritesOnly?: boolean;
}): Promise<GeneratedImageRow[]> {
  const d = await db();
  const terms = (params.query ?? "")
    .trim()
    .toLowerCase()
    .split(/[\s\u3000]+/)
    .filter(Boolean)
    .slice(0, 5);

  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  if (params.favoritesOnly) conditions.push("a.favorite = 1");
  for (const term of terms) {
    conditions.push(
      // エスケープの仕方は会話検索と揃える。% と _ を落としてしまうと
      // 「50%」のような語が「50」として検索されて結果が変わる
      `(LOWER(COALESCE(a.prompt, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(m.model_id, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(c.title, '')) LIKE ? ESCAPE '\\')`,
    );
    const like = `%${escapeLike(term)}%`;
    binds.push(like, like, like);
  }
  binds.push(params.before ?? Number.MAX_SAFE_INTEGER);
  binds.push(params.limit);

  const { results } = await d
    .prepare(generatedImagesSql(conditions))
    .bind(...binds)
    .all<GeneratedImageRow>();
  return results;
}

/**
 * 実体が用済みになったかもしれないキーを控える（監査 B-10）。
 *
 * ここでは数えず、落としもしない。実体は分岐・フォークで共有されるので、
 * 以前は「行を消したあとに生き残りを数え、0なら落とす」としていたが、
 * **数えてから落とすまでのあいだにフォークが走ると、参照が復活した
 * キーを消してしまう**。D1 と R2 はまたいで原子的に扱えないので、
 * 数える位置をずらしても窓は消えない。
 *
 * 代わりに時間を空ける。ここは控えるだけにして、猶予を過ぎてから
 * 数え直して落とす（sweepPendingFileDeletions）。フォークは1回の要求で
 * 読んで書くので、猶予のあいだずっと途中で止まっていることは無い。
 *
 * 控えるのは候補のまま——参照が残っているかどうかは、落とす直前に
 * 一箇所だけで判断する。
 */
async function notePossiblyUnreferenced(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const d = await db();
  const now = Date.now();
  // 1文あたりのバインド上限（100）に収める。2個ずつ使うので半分で切る
  for (const part of chunked([...new Set(keys)], Math.floor(BIND_CHUNK / 2))) {
    await d.batch(
      part.map((key) => d.prepare(QUEUE_PENDING_DELETION_SQL).bind(key, now)),
    );
  }
  // ついでに、前回までの控えを片づける（削除以外に控えが増える経路は無い）
  await sweepPendingFileDeletions();
}

/**
 * 猶予を過ぎた控えを数え直し、まだ誰も参照していないものだけ落とす。
 *
 * 落とす直前に数えるのがこの仕組みの要。控えた時点では用済みでも、
 * 猶予のあいだにフォークで参照が復活していることがある。
 */
export async function sweepPendingFileDeletions(): Promise<void> {
  const d = await db();
  const { results: due } = await d
    .prepare(DUE_PENDING_DELETIONS_SQL)
    .bind(Date.now() - PENDING_DELETION_GRACE_MS)
    .all<{ r2_key: string }>();
  if (due.length === 0) return;

  const keys = due.map((r) => r.r2_key);
  const stillUsed = new Set<string>();
  for (const part of chunked(keys)) {
    const { results } = await d
      .prepare(stillReferencedSql(part.length))
      .bind(...part)
      .all<{ r2_key: string }>();
    for (const r of results) stillUsed.add(r.r2_key);
  }

  await deleteFiles(keys.filter((k) => !stillUsed.has(k)));
  // 生き残ったぶんも控えから外す。用済みになれば削除の側がまた控える
  for (const part of chunked(keys)) {
    await d
      .prepare(clearPendingDeletionsSql(part.length))
      .bind(...part)
      .run();
  }
}

/**
 * 添付行を削除し、どのメッセージからも参照されなくなったR2オブジェクトを消す。
 */
async function deleteAttachmentRows(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const d = await db();
  const keys = new Set<string>();
  // 添付が100件を超える会話でも消せるように、IN句はバインド上限で切る
  for (const part of chunked(ids)) {
    const placeholders = part.map(() => "?").join(",");
    const { results: doomed } = await d
      .prepare(`SELECT r2_key FROM attachments WHERE id IN (${placeholders})`)
      .bind(...part)
      .all<{ r2_key: string }>();
    if (doomed.length === 0) continue;
    await d
      .prepare(`DELETE FROM attachments WHERE id IN (${placeholders})`)
      .bind(...part)
      .run();
    for (const r of doomed) keys.add(r.r2_key);
  }
  await notePossiblyUnreferenced([...keys]);
}

/** 指定メッセージ群に属する添付行を引く。 */
async function attachmentsOfMessages(
  messageIds: string[],
): Promise<{ id: string; r2_key: string }[]> {
  if (messageIds.length === 0) return [];
  const d = await db();
  const rows: { id: string; r2_key: string }[] = [];
  // 101件以上のメッセージをまとめて消してもバインド上限で落ちないように切る
  for (const part of chunked(messageIds)) {
    const { results } = await d
      .prepare(
        `SELECT id, r2_key FROM attachments WHERE message_id IN (${part
          .map(() => "?")
          .join(",")})`,
      )
      .bind(...part)
      .all<{ id: string; r2_key: string }>();
    rows.push(...results);
  }
  return rows;
}

/**
 * メッセージに紐づかないまま放置された添付を掃除する。
 * 画像を選んだあと送信せずに離脱した場合に発生する。
 */
const ORPHAN_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

export async function sweepOrphanAttachments(): Promise<void> {
  // 消す候補の控えも一緒に片づける。控えが増えるのは削除のときだけだが、
  // 削除を最後にやったきり何もしないと、猶予が過ぎた控えが残り続ける
  await sweepPendingFileDeletions();
  const d = await db();
  const { results } = await d
    .prepare(
      "SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ? LIMIT 100",
    )
    .bind(Date.now() - ORPHAN_ATTACHMENT_TTL_MS)
    .all<{ id: string }>();
  await deleteAttachmentRows(results.map((r) => r.id));
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
  /** 新しいユーザーメッセージに添付する画像（アップロード済みID）。 */
  userAttachmentIds?: string[];
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
        .prepare(INSERT_USER_MESSAGE_SQL)
        .bind(userMessageId, params.conversationId, parent, params.userContent, now),
    );
    const attachments = await getAttachments(params.userAttachmentIds ?? []);
    statements.push(
      ...linkAttachmentStatements(d, attachments, {
        messageId: userMessageId,
        conversationId: params.conversationId,
      }),
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
 * ユーザーの発言を1件だけ保存する（生成はしない）。
 *
 * 編集の「保存」。書き直した文面を枝として残しておき、送るのは後から
 * ——という使い方のため。生成を伴わないので、応答のプレースホルダも
 * 未読の印も作らない（自分でやった操作なので、知らせる相手がいない）。
 *
 * 表示中の枝は保存したところへ移す。移さないと、保存したのに画面は
 * 元の枝のままで、何が起きたのか分からない。
 */
export async function appendUserMessage(params: {
  conversationId: string;
  parentId: string | null;
  content: string;
  /** 添付する画像（アップロード済み、または既にどこかに紐づいた添付ID）。 */
  attachmentIds?: string[];
}): Promise<string> {
  const d = await db();
  const now = Date.now();
  const id = crypto.randomUUID();
  // 既に別の発言へ紐づいている添付は、付け替えではなく複製になる
  // （元の枝から画像が消えないように。linkAttachmentStatements を参照）
  const attachments = await getAttachments(params.attachmentIds ?? []);
  await d.batch([
    d
      .prepare(INSERT_USER_MESSAGE_SQL)
      .bind(id, params.conversationId, params.parentId, params.content, now),
    ...linkAttachmentStatements(d, attachments, {
      messageId: id,
      conversationId: params.conversationId,
    }),
    d
      .prepare(
        "UPDATE conversations SET current_leaf_message_id = ?, updated_at = ? WHERE id = ?",
      )
      .bind(id, now, params.conversationId),
  ]);
  return id;
}

/**
 * 生成の開始を取り消す。
 *
 * beginGeneration は行を保存してから返る。そのあとで生成の実行を
 * 登録できなかった場合（Durable Object の起動に失敗した等）、保存だけが
 * 残る——ユーザーの発言と、永久に「生成中」のままの応答が木に積まれる。
 * 利用者から見ると失敗したので送り直すが、そのたびに**同じ発言が
 * 増えていく**。
 *
 * 始める前の状態へ戻す。添付は消さずに紐づけだけ外す（アップロード
 * 済みのものを捨てる理由は無い。使われないまま残ったものは、既存の
 * 掃除が拾う）。
 */
export async function undoGeneration(params: {
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string;
  /** 開始前の葉。生成前に見ていた位置へ戻す。 */
  previousLeafId: string | null;
}): Promise<void> {
  const d = await db();
  await d.batch(
    undoGenerationStatements(params).map((st) =>
      d.prepare(st.sql).bind(...st.binds),
    ),
  );
}

/**
 * 生成中の部分保存。停止要求が入っていれば true を返す。
 *
 * 保存と停止要求の確認は1回のbatchにまとめる。D1への呼び出しも
 * サブリクエストとして数えられ、生成中はこれが最も高い頻度で走るため
 * （1回の実行あたりの上限に一番近づくのがここ）。
 */
export async function flushGeneration(
  messageId: string,
  partial: { content: string; reasoning: string | null },
): Promise<{ stopRequested: boolean }> {
  const d = await db();
  const [, check] = await d.batch<{ stop_requested: number }>([
    d
      .prepare(
        "UPDATE messages SET content = ?, reasoning = ?, flushed_at = ? WHERE id = ? AND status = 'streaming'",
      )
      .bind(partial.content, partial.reasoning, Date.now(), messageId),
    d
      .prepare("SELECT stop_requested FROM messages WHERE id = ?")
      .bind(messageId),
  ]);
  return { stopRequested: (check.results[0]?.stop_requested ?? 0) === 1 };
}

/**
 * 生成の完了・エラー・停止を確定させる。
 *
 * 対象が「生成中」の行であることを条件にする。中断とみなされて確定済みの
 * 行（sweepStaleStreaming が倒したもの）を後から書き戻すと、死んだはずの
 * メッセージが done に戻り、停止ボタンも効かないまま二重に走ってしまう。
 * 確定できたときだけ true を返す。
 */
/**
 * 最後に取れた USD/JPY。
 *
 * 上限の判定は円で行うが、台帳はドル建て。判定のたびに外部の為替APIを
 * 叩くと、Durable Object の外部リクエスト枠を食うし、APIが落ちている
 * あいだ判定そのものができなくなる。取れたときに書いておき、判定は
 * こちらを読む。
 */
const USD_JPY_KEY = "usd_jpy";

export async function storeUsdJpy(rate: number): Promise<void> {
  if (!Number.isFinite(rate) || rate <= 0) return;
  const d = await db();
  await d
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
    )
    .bind(USD_JPY_KEY, String(rate))
    .run();
}

export async function readStoredUsdJpy(): Promise<number | null> {
  const d = await db();
  const row = await d
    .prepare("SELECT value FROM meta WHERE key = ?")
    .bind(USD_JPY_KEY)
    .first<{ value: string }>();
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 台帳に載せる種別。何にいくら使ったかを後から分けて見るため。 */
export type UsageKind = "chat" | "retry" | "title";

/** usage_json から数値を1つ取り出す（壊れていたら無いものとして扱う）。 */
function usageNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 確定した応答の使用量を台帳へ載せる。
 *
 * モデルIDと会話IDは messages から引く（呼ぶ側が持ち回らなくて済むよう、
 * INSERT ... SELECT で1回の往復にする）。message_id には一意制約が
 * あるので、同じ応答を二度確定しようとしても二重には計上されない。
 */
export async function recordMessageUsage(
  messageId: string,
  usageJson: string | null,
  kind: UsageKind,
): Promise<void> {
  if (!usageJson) return;
  let u: Record<string, unknown>;
  try {
    u = JSON.parse(usageJson) as Record<string, unknown>;
  } catch {
    return;
  }
  const cost = usageNumber(u.cost);
  const points = usageNumber(u.points);
  // 額もポイントも無いなら、支出としては記録するものが無い
  if (cost == null && points == null) return;

  const d = await db();
  await d
    .prepare(
      `INSERT OR IGNORE INTO usage_events
         (id, at, kind, provider, model_id, cost_usd, points,
          prompt_tokens, completion_tokens, conversation_id, message_id)
       SELECT ?, ?, ?,
              CASE WHEN model_id LIKE ? THEN 'poe' ELSE 'openrouter' END,
              model_id, ?, ?, ?, ?, conversation_id, id
         FROM messages WHERE id = ?`,
    )
    .bind(
      crypto.randomUUID(),
      Date.now(),
      kind,
      `${POE_PREFIX}%`,
      cost,
      points,
      usageNumber(u.promptTokens),
      usageNumber(u.completionTokens),
      messageId,
    )
    .run();
}

/**
 * メッセージに紐づかない支出を台帳へ載せる（タイトル生成など）。
 */
export async function recordStandaloneUsage(entry: {
  kind: UsageKind;
  modelId: string;
  costUsd: number | null;
  points?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
}): Promise<void> {
  if (entry.costUsd == null && entry.points == null) return;
  const d = await db();
  await d
    .prepare(
      `INSERT INTO usage_events
         (id, at, kind, provider, model_id, cost_usd, points,
          prompt_tokens, completion_tokens, conversation_id, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      crypto.randomUUID(),
      Date.now(),
      entry.kind,
      entry.modelId.startsWith(POE_PREFIX) ? "poe" : "openrouter",
      entry.modelId,
      entry.costUsd,
      entry.points ?? null,
      entry.promptTokens ?? null,
      entry.completionTokens ?? null,
    )
    .run();
}

/** 期間の合計。上限の判定と使用量の画面が使う。 */
interface UsageTotalsRow {
  cost_usd: number;
  points: number;
  points_without_cost: number;
  events: number;
}

function toTotals(row: UsageTotalsRow | undefined | null): UsageTotals {
  if (!row) return { ...EMPTY_TOTALS };
  return {
    costUsd: row.cost_usd ?? 0,
    points: row.points ?? 0,
    pointsWithoutCost: row.points_without_cost ?? 0,
    events: row.events ?? 0,
  };
}

export async function usageTotalsSince(since: number): Promise<UsageTotals> {
  const d = await db();
  const row = await d
    .prepare(USAGE_TOTALS_SQL)
    .bind(since)
    .first<UsageTotalsRow>();
  return toTotals(row);
}

/**
 * 保管しているものの大きさ（使用量の画面の「Cloudflare」欄）。
 *
 * D1 の大きさは応答に載る `meta.size_after` から取る。Cloudflare の API を
 * 叩けば正確な値も取れるが、そのためだけにアカウントID とトークンを
 * 秘密として持つことになる。ここで足りるものを、既にある往復から拾う。
 */
export interface StorageStats {
  /** D1 のデータベース本体のバイト数。取れなければ null。 */
  d1Bytes: number | null;
  /** R2 に置いてある実体の数と、その合計バイト数（attachments の記録から）。 */
  files: number;
  fileBytes: number;
  conversations: number;
  messages: number;
  usageEvents: number;
  /** 消す候補として控えてあるキーの数（猶予が過ぎたら実際に落ちる）。 */
  pendingDeletions: number;
}

interface StorageRow {
  conversations: number;
  messages: number;
  usage_events: number;
  files: number;
  file_bytes: number;
  pending_deletions: number;
}

function toStorageStats(res: D1Result<StorageRow>): StorageStats {
  const row = res.results[0];
  // size_after は D1 が付ける値。付かない実装（ローカルの代替など）でも
  // 画面が壊れないように「取れなかった」を持てる形にする
  const size = res.meta?.size_after;
  return {
    d1Bytes: typeof size === "number" && size > 0 ? size : null,
    files: row?.files ?? 0,
    fileBytes: row?.file_bytes ?? 0,
    conversations: row?.conversations ?? 0,
    messages: row?.messages ?? 0,
    usageEvents: row?.usage_events ?? 0,
    pendingDeletions: row?.pending_deletions ?? 0,
  };
}

/** 使用量の画面がまとめて読むもの。 */
export interface UsageOverview {
  /** 期間ごとの合計（画面側で切り替える）。 */
  totals: Record<UsageRange, UsageTotals>;
  /** 期間ごとのモデル別内訳。 */
  byModel: Record<UsageRange, UsageByModel[]>;
  storage: StorageStats;
}

/**
 * 使用量の画面ぶんを1回のbatchで読む。
 *
 * 期間の切り替え（今日 / 直近7日 / 今月）はページを開き直さず画面側で
 * 行う。押すたびにサーバーへ行くと、そのたびに親レイアウトのローダー
 * （会話一覧・ボット・フォルダ）まで走り直すことになる——見たいのは
 * 同じ台帳の切り口だけなので、最初にまとめて受け取っておく。
 *
 * batch は全体で1サブリクエストとして数えられるので、7文をまとめても
 * 消費は1回ぶん（Cloudflareの制約は CLAUDE.md 参照）。
 */
export async function readUsageOverview(
  now: number,
): Promise<UsageOverview> {
  const d = await db();
  /*
   * 何をどの順で流すかを、先に1つの並びとして持つ。読むときも同じ
   * 並びを辿るので、文を足したときに**読む側の添字だけがずれる**
   * ことがない（ずれても型は通り、画面には別の期間の数字が出る）。
   */
  const plan = USAGE_RANGES.flatMap((range) =>
    (["totals", "byModel"] as const).map((kind) => ({ range, kind })),
  );
  const results = await d.batch([
    ...plan.map((p) =>
      d
        .prepare(p.kind === "totals" ? USAGE_TOTALS_SQL : USAGE_BY_MODEL_SQL)
        .bind(usageRangeStart(p.range, now)),
    ),
    d.prepare(STORAGE_STATS_SQL),
  ]);

  const totals = {} as Record<UsageRange, UsageTotals>;
  const byModel = {} as Record<UsageRange, UsageByModel[]>;
  plan.forEach((p, i) => {
    if (p.kind === "totals") {
      totals[p.range] = toTotals(
        (results[i] as D1Result<UsageTotalsRow>).results[0],
      );
    } else {
      byModel[p.range] = (
        results[i] as D1Result<UsageByModelRow>
      ).results.map(toByModel);
    }
  });
  return {
    totals,
    byModel,
    storage: toStorageStats(results[plan.length] as D1Result<StorageRow>),
  };
}

/** モデル別の内訳。使用量の画面で「何が高いか」を見るため。 */
export interface UsageByModel {
  modelId: string | null;
  provider: string;
  costUsd: number;
  points: number;
  events: number;
}

interface UsageByModelRow {
  model_id: string | null;
  provider: string;
  cost_usd: number;
  points: number;
  events: number;
}

function toByModel(r: UsageByModelRow): UsageByModel {
  return {
    modelId: r.model_id,
    provider: r.provider,
    costUsd: r.cost_usd ?? 0,
    points: r.points ?? 0,
    events: r.events ?? 0,
  };
}

export async function usageByModelSince(
  since: number,
): Promise<UsageByModel[]> {
  const d = await db();
  const { results } = await d
    .prepare(USAGE_BY_MODEL_SQL)
    .bind(since)
    .all<UsageByModelRow>();
  return (results ?? []).map(toByModel);
}

export async function finalizeGeneration(
  messageId: string,
  result: {
    content: string;
    reasoning: string | null;
    usageJson: string | null;
    status: "done" | "error";
    error?: string | null;
    /** 参照元のJSON。Webツールを使わなかった応答では null。 */
    citationsJson?: string | null;
    /** 台帳へ載せる種別。既定は通常のチャット。 */
    kind?: UsageKind;
  },
): Promise<boolean> {
  const d = await db();
  const [applied] = await d.batch([
    d
      .prepare(
        "UPDATE messages SET content = ?, reasoning = ?, usage_json = ?, status = ?, error = ?, citations_json = ?, flushed_at = ? WHERE id = ? AND status = 'streaming'",
      )
      .bind(
        result.content,
        result.reasoning,
        result.usageJson,
        result.status,
        result.error ?? null,
        result.citationsJson ?? null,
        Date.now(),
        messageId,
      ),
    // 完成を会話一覧で知らせる。開いている会話はクライアントがすぐ落とす
    d
      .prepare(
        "UPDATE conversations SET unread = 1 WHERE id = (SELECT conversation_id FROM messages WHERE id = ?)",
      )
      .bind(messageId),
  ]);
  const changed = (applied.meta.changes ?? 0) > 0;

  // 台帳はここで載せる。呼ぶ側が5箇所あり、1つ忘れるだけで
  // 支出が見えなくなるため、確定の中に閉じ込める。
  // 更新が当たらなかったときは、別の経路が既に確定させている
  // （＝そちらで載っている）ので二重に数えない。
  if (changed) {
    // 台帳に載せ損ねても確定は失敗させない。ここで投げると、応答が
    // 「生成中」のまま止まる——課金は既に済んでいるのだから、記録の
    // 失敗より画面が固まるほうが害が大きい。黙って飲み込みはしない
    try {
      await recordMessageUsage(
        messageId,
        result.usageJson,
        result.kind ?? "chat",
      );
    } catch (e) {
      console.error("[usage] 台帳への記録に失敗しました", messageId, e);
    }
  }
  return changed;
}

/**
 * 確定済みメッセージの本文を差し替える。
 *
 * 生成の確定ではなく、あとから画像を自前のストレージへ取り込んで本文の
 * URLを書き換えるための入口。対象は appendAssistantMessage で既に done に
 * なっている行なので、finalizeGeneration の「生成中のみ」条件は使えない。
 */
export async function rewriteMessageContent(
  messageId: string,
  content: string,
): Promise<void> {
  const d = await db();
  await d
    .prepare("UPDATE messages SET content = ? WHERE id = ?")
    .bind(content, messageId)
    .run();
}

/** サイドバーの印。未読と、いま生成中の会話。 */
export interface ConversationFlags {
  /** 応答が完成したのにまだ開いていない会話。 */
  unread: string[];
  /** いま生成が走っている会話（タイトルを光らせる）。 */
  generating: string[];
  /**
   * 会話一覧のうち、最後に何かが動いた時刻。
   *
   * 一覧そのものを数秒おきに引く代わりに、この1つの数字が動いたときだけ
   * 取り直す（並び替え・新しい会話・タイトルの変化はすべて updated_at を
   * 動かす）。何も無ければ 0。
   */
  latest: number;
}

/**
 * サイドバーの印を再読み込みなしで更新するために引く。
 *
 * 2つの問い合わせを batch でまとめる。表示中は数秒おきに引くので、
 * 別々に投げるとサブリクエストの消費が倍になる（batch 全体で1回）。
 */
export async function listConversationFlags(): Promise<ConversationFlags> {
  const d = await db();
  const [unread, generating, latest] = await d.batch([
    d.prepare("SELECT id FROM conversations WHERE unread = 1"),
    d.prepare(GENERATING_CONVERSATIONS_SQL).bind(Date.now() - STALE_STREAMING_MS),
    d.prepare(CONVERSATIONS_LATEST_SQL),
  ]);
  const ids = (rows: unknown[]) =>
    (rows as { id: string | null }[])
      .map((r) => r.id)
      .filter((id): id is string => id != null);
  const newest = (latest.results as { latest: number | null }[])[0]?.latest;
  return {
    unread: ids(unread.results),
    generating: ids(generating.results),
    latest: typeof newest === "number" ? newest : 0,
  };
}

/** 会話を既読にする（開いたとき・応答を見届けたとき）。 */
export async function markConversationRead(id: string): Promise<void> {
  const d = await db();
  await d
    .prepare("UPDATE conversations SET unread = 0 WHERE id = ?")
    .bind(id)
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

  // 境界線が乗ったメッセージを消したら、生き残る直近の祖先へ移す。
  // そうしないと、1件消しただけで文脈が黙って元の長さに戻ってしまう。
  // 祖先が残らない（先頭ごと消した）ときは、遡る先が無いので落とすだけ。
  for (const m of all) {
    if (!deleteSet.has(m.id) || m.context_boundary !== 1) continue;
    const host = surviveParent(m.parent_id);
    if (host) {
      statements.push(
        d
          .prepare("UPDATE messages SET context_boundary = 1 WHERE id = ?")
          .bind(host),
      );
    }
  }

  for (const id of deleteSet) {
    statements.push(d.prepare("DELETE FROM messages WHERE id = ?").bind(id));
  }

  // 添付は行の削除を同じ batch に入れる。先に消してしまうと、後続の
  // 削除が失敗したときにメッセージだけ残って画像が消えた形になる
  const doomed = await attachmentsOfMessages([...deleteSet]);
  for (const part of chunked(doomed.map((a) => a.id))) {
    statements.push(
      d
        .prepare(
          `DELETE FROM attachments WHERE id IN (${part
            .map(() => "?")
            .join(",")})`,
        )
        .bind(...part),
    );
  }
  await d.batch(statements);
  // R2の実体は行が消えたあとに片づける（消し損ねは孤児として拾えるが、
  // 逆に実体だけ先に消すと取り返しがつかない）
  await notePossiblyUnreferenced([...new Set(doomed.map((a) => a.r2_key))]);
}

/**
 * コンテキストの境界線を立てる/解除する。
 *
 * 立てたメッセージまで（それ自身を含む）は、以後の生成でモデルへ送らない。
 * 履歴そのものには手を触れないので、解除すれば元どおり全部が文脈に戻る。
 */
export async function setContextBoundary(
  conversationId: string,
  messageId: string,
  enabled: boolean,
): Promise<boolean> {
  const d = await db();
  const res = await d
    .prepare(
      "UPDATE messages SET context_boundary = ? WHERE id = ? AND conversation_id = ?",
    )
    .bind(enabled ? 1 : 0, messageId, conversationId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * 既存メッセージの下にアシスタントの応答を1件足し、リーフを移す。
 *
 * リトライ生成で、成功するたびに応答を積み増していくために使う。
 * 分岐（兄弟）ではなく直列に繋ぐので、左右の切り替えなしで全部見える。
 */
export async function appendAssistantMessage(params: {
  conversationId: string;
  parentId: string;
  modelId: string;
  content: string;
  usageJson?: string | null;
}): Promise<string> {
  const d = await db();
  const id = crypto.randomUUID();
  const statements = appendAssistantMessageStatements({
    id,
    conversationId: params.conversationId,
    parentId: params.parentId,
    modelId: params.modelId,
    content: params.content,
    usageJson: params.usageJson ?? null,
    now: Date.now(),
  });
  await d.batch(statements.map((st) => d.prepare(st.sql).bind(...st.binds)));
  return id;
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

