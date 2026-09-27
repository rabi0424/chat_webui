/**
 * 会話の木から「表示中のパス」を組み立てる、純粋な部分。
 *
 * D1 から読んだ行を受け取り、current_leaf からルートまで遡って並べ、
 * 兄弟（ページャ）と添付を付ける。db.server.ts から切り出してあるのは、
 * 同じ組み立てを**2種類の行**に当てるため:
 *   - 本文まで読んだ行（画面へ返す）
 *   - 本文を読まない軽い行（札だけを作り、変わっていなければ 304 で返す）
 * 両者の札が一致しないと 304 が永久に返らない（静かに重くなるだけで画面は
 * 壊れない）。同じ関数を通せば食い違う余地が無く、本物の SQLite に両方を
 * 流して一致を確かめられる（tests/schema.test.ts「パスの札」）。
 */

/** 木を組むのに要る列。 */
export interface TreeRow {
  id: string;
  parent_id: string | null;
  created_at: number;
}

/** 親ごとの子（作成順）。 */
export function childrenByParent<T extends TreeRow>(
  all: T[],
): Map<string | null, T[]> {
  const map = new Map<string | null, T[]>();
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

/** current_leaf からルートまで遡り、表示順（古→新）に並べる。 */
export function pathRows<T extends TreeRow>(
  leafId: string | null,
  all: T[],
): T[] {
  if (!leafId) return [];
  const byId = new Map(all.map((m) => [m.id, m]));
  const rows: T[] = [];
  let cursor = byId.get(leafId);
  while (cursor) {
    rows.push(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return rows.reverse();
}

export type Decorated<T, A> = T & {
  /** 同じ親を持つ兄弟（自分含む、作成順）。 */
  sibling_ids: string[];
  sibling_index: number;
  /** このメッセージに添付された画像（作成順）。 */
  attachments: A[];
};

/** 道筋の各行に兄弟情報と添付を付ける。 */
export function decoratePath<T extends TreeRow, A>(
  rows: T[],
  all: T[],
  attachments: Map<string, A[]>,
): Decorated<T, A>[] {
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

/** 添付を、メッセージIDごとにまとめる。 */
export function groupByMessage<A extends { message_id: string | null }>(
  rows: A[],
): Map<string, A[]> {
  const map = new Map<string, A[]>();
  for (const a of rows) {
    if (!a.message_id) continue;
    const list = map.get(a.message_id) ?? [];
    list.push(a);
    map.set(a.message_id, list);
  }
  return map;
}
