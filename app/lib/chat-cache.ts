/**
 * 会話画面データのメモリキャッシュと先読み。
 *
 * サイドバーで会話リンクが画面に入った時点で先読みし、タップ時は
 * chat/:id の clientLoader がここから即返す。ネットワーク待ちが
 * 消えるので、遷移は描画コストだけになる。
 *
 * 鮮度: TTLは短め。開いた会話は本文が動いた時点で無効化される
 * （Chat側が invalidateChat を呼ぶ）ので、古い内容を見続けることは
 * ない。生成途中のスナップショットを掴んでも、Chat のポーリングが
 * 追いついて最新化する。
 *
 * ただし**別の端末で進んだ分**は、この端末の Chat が知らないので
 * 無効化されない。60秒のあいだに開くと古い内容がそのまま出て、しかも
 * 「開いた」ことで既読になる——新しい応答を一度も見ないまま印が消える。
 * 一覧が持っている更新時刻を突き合わせて、追い越されたものは捨てる。
 */

import type { ConversationRow } from "./db.server";
import type { UiMessage } from "./types";

export interface ChatData {
  conversation: ConversationRow;
  messages: UiMessage[];
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 30;

const cache = new Map<string, { at: number; data: ChatData }>();
const inflight = new Set<string>();

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
  if (Date.now() - entry.at > TTL_MS || outdated(entry.data)) {
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

/** 画面に入った会話リンクの先読み。多重・取得済みは何もしない。 */
export function prefetchChat(id: string): void {
  if (getCachedChat(id) || inflight.has(id)) return;
  inflight.add(id);
  fetch(`/api/conversations/${id}/full`)
    .then(async (res) => {
      if (!res.ok) return;
      const data = (await res.json()) as ChatData;
      // 取っている間に追い越されていたら置かない
      if (!outdated(data)) putCachedChat(id, data);
    })
    .catch(() => {
      // 先読みの失敗は無視（タップ時に通常経路で取る）
    })
    .finally(() => {
      inflight.delete(id);
    });
}
