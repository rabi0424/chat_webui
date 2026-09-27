/**
 * 会話画面データのメモリキャッシュと先読み。
 *
 * サイドバーで会話リンクが画面に入った時点（と、指やポインタが乗った
 * 時点）で先読みし、タップ時は chat/:id の clientLoader がここから即返す。
 * ネットワーク待ちが消えるので、遷移は描画コストだけになる。
 *
 * **鮮度は一覧の更新時刻で決める。** 開いた会話は本文が動いた時点で
 * 無効化される（Chat側が invalidateChat を呼ぶ）。**別の端末で進んだ分**は
 * この端末の Chat が知らないので無効化されないが、一覧は未読の引き直しが
 * 「何かが動いた」のを見つけるたびに取り直されるので、その更新時刻より
 * 古い写しは捨てる（outdated）。これで生成の進みは拾える。
 *
 * 以前は固定の60秒で捨てていた。60秒を過ぎた写しは二度と取り直されず
 * （監視は最初に見えた1回で外れていた）、開いた一覧を1分眺めてから
 * 押すと、どの会話もサーバーを待っていた。
 *
 * それでも上限の時間（MAX_AGE_MS）は残す。**updated_at を動かさない変更**
 * ——別の端末での枝の切り替え・モデルや生成パラメータの変更——は一覧の
 * 時刻では分からないので、その食い違いが残る長さの上限として置く。
 * タイトルは一覧から取る（lib/conversation-title.ts）ので、ここには
 * 掛からない。
 *
 * 先読みは**同時に PREFETCH_CONCURRENCY 本まで**。ドロワーを開くと
 * 20行ほどが一度に画面に入り、それぞれが会話を丸ごと引く要求を同時に
 * 投げて、押した会話の読み込みがその後ろに並んでいた。
 */
import type { ConversationRow } from "./db.server";
import type { UiMessage } from "./types";

export interface ChatData {
  conversation: ConversationRow;
  messages: UiMessage[];
}

/** 一覧の時刻では分からない変更（上の説明）を、最長でもこれだけで捨てる。 */
export const MAX_AGE_MS = 5 * 60_000;
const MAX_ENTRIES = 30;
/**
 * 先読みの同時数。会話の遷移（押した会話の読み込み）とモデル一覧の
 * 取得のぶんを空けておく。
 */
export const PREFETCH_CONCURRENCY = 2;
/**
 * 待ち行列の長さ。写しは MAX_ENTRIES しか持てないので、それより多く
 * 並べても先に取ったものから押し出されて捨てるだけになる。
 */
const MAX_QUEUE = MAX_ENTRIES;

const cache = new Map<string, { at: number; data: ChatData }>();
/** 取りに行っている最中のもの。押した会話がここに居れば、同じものを待つ。 */
const inflight = new Map<string, Promise<ChatData | null>>();
/**
 * まだ投げていない先読み。先頭から投げる。指が乗ったもの（intent）は
 * 先頭へ、画面に入っただけのものは末尾へ積む。
 */
const queue: string[] = [];

/**
 * 一覧が知っている最新の更新時刻。
 *
 * サイドバーは会話の行を定期的に取り直しているので、別の端末で進んだ
 * 分もここには届く。取ってあるスナップショットがこれより古ければ、
 * 見せる前に捨てる。
 */
const knownUpdatedAt = new Map<string, number>();

/** 一覧が受け取った行から、鮮度の目安を控える。 */
export function noteConversations(
  rows: { id: string; updated_at: number }[],
): void {
  for (const r of rows) {
    const prev = knownUpdatedAt.get(r.id) ?? 0;
    if (r.updated_at > prev) knownUpdatedAt.set(r.id, r.updated_at);
  }
}

/** そのスナップショットは、一覧が知っているものより古いか。 */
function outdated(data: ChatData): boolean {
  const known = knownUpdatedAt.get(data.conversation.id);
  return known != null && known > data.conversation.updated_at;
}

export function getCachedChat(id: string): ChatData | null {
  const entry = cache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.at > MAX_AGE_MS || outdated(entry.data)) {
    cache.delete(id);
    return null;
  }
  return entry.data;
}

export function putCachedChat(id: string, data: ChatData): void {
  cache.delete(id);
  cache.set(id, { at: Date.now(), data });
  // 古い順（挿入順）に間引く
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

export function invalidateChat(id: string): void {
  cache.delete(id);
}

/**
 * 先読みを頼む。取得済み（新しいもの）・取りに行っている最中なら何もしない。
 *
 * intent は「指やポインタが乗った」——押される見込みが高いので、並んで
 * いる先読みより先に回す。画面に入っただけのものは後ろに並べる。
 */
export function prefetchChat(
  id: string,
  { intent = false }: { intent?: boolean } = {},
): void {
  if (getCachedChat(id) || inflight.has(id)) return;
  const at = queue.indexOf(id);
  if (at !== -1) {
    if (!intent) return;
    queue.splice(at, 1);
  }
  if (intent) queue.unshift(id);
  else queue.push(id);
  // 溢れたら、いちばん後ろ（最後に見えただけのもの）から諦める
  while (queue.length > MAX_QUEUE) queue.pop();
  pump();
}

/**
 * まだ投げていない先読みを取り下げる。行が画面から出た・外れたとき。
 * 一覧を勢いよく流すと200行が次々に画面を通り過ぎるので、通り過ぎた
 * ものまで順に取りに行かないようにする。
 */
export function cancelPrefetch(id: string): void {
  const at = queue.indexOf(id);
  if (at !== -1) queue.splice(at, 1);
}

/**
 * いま取りに行っている先読み。押した会話の先読みが途中なら、同じ要求を
 * もう1本投げずにそれを待つ（clientLoader）。無ければ null。
 */
export function pendingChat(id: string): Promise<ChatData | null> | null {
  return inflight.get(id) ?? null;
}

/** 空きがあるだけ、待ち行列の先頭から投げる。 */
function pump(): void {
  while (inflight.size < PREFETCH_CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!;
    // 並んでいるあいだに別の経路（会話を開いた）で入っていることがある
    if (getCachedChat(id)) continue;
    const job = fetch(`/api/conversations/${id}/full`)
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as ChatData;
        // 取っている間に追い越されていたら置かない
        if (outdated(data)) return null;
        putCachedChat(id, data);
        return data;
      })
      .catch(() => {
        // 先読みの失敗は無視（タップ時に通常経路で取る）
        return null;
      })
      .finally(() => {
        inflight.delete(id);
        pump();
      });
    inflight.set(id, job);
  }
}

/** 何も持っていない状態へ戻す（テストの間の後始末）。 */
export function resetChatCache(): void {
  cache.clear();
  queue.length = 0;
  inflight.clear();
  knownUpdatedAt.clear();
}
