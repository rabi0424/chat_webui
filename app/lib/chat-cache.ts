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

export function getCachedChat(id: string): ChatData | null {
  const entry = cache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
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
      putCachedChat(id, (await res.json()) as ChatData);
    })
    .catch(() => {
      // 先読みの失敗は無視（タップ時に通常経路で取る）
    })
    .finally(() => {
      inflight.delete(id);
    });
}
