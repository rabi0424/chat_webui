/**
 * サイドバーの操作を、サーバーの返事を待たずに一覧へ映すための重ね書き。
 *
 * 名前の変更・ピン留め・お気に入り・フォルダへの移動・並べ替えは、以前は
 * PATCH の返事を待ち、さらにシェルのローダー（会話200件ぶん）を取り直して
 * から画面が変わっていた——往復2回。名前の変更では、入力欄が閉じてから
 * 取り直しが着くまで**古い名前が出ていた**（打ち間違えたように見える）。
 *
 * そこで、ローダーの一覧はそのままに、その上へ「送った変更」を重ねて
 * 見せる。失敗したら重ねたものを外し（元に戻る）、成功したら取り直した
 * 一覧が着いた時点で外す。着く前に外すと、一瞬古い値に戻って見える。
 *
 * ここは純粋な組み立てだけ。いつ外すかは Sidebar が決める。
 */
import type { ConversationListRow, FolderRow } from "./db.server";

export interface OverlayPatch {
  conversations: Record<string, Partial<ConversationListRow>>;
  folders: Record<string, Partial<FolderRow>>;
}

/** 一覧へ重ねる。変更の無い行は同じ物のまま返す（行の memo を壊さない）。 */
export function applyOverlay<T extends { id: string }>(
  rows: T[],
  patches: Record<string, Partial<T>>[],
): T[] {
  if (patches.length === 0) return rows;
  let changed = false;
  const next = rows.map((row) => {
    let out = row;
    for (const p of patches) {
      const patch = p[row.id];
      if (patch) out = { ...out, ...patch };
    }
    if (out !== row) changed = true;
    return out;
  });
  return changed ? next : rows;
}

/**
 * 会話の PATCH の本文を、一覧の行の形へ写す。
 *
 * API は真偽値（pinned: true）と folderId で受け取り、行は 0/1 と
 * folder_id で持つ。写し方を間違えると、重ねた値が行の比較
 * （`c.pinned === 1` など）に当たらず、押しても何も変わらなく見える。
 */
export function conversationPatchFromBody(
  body: Record<string, unknown>,
): Partial<ConversationListRow> {
  const out: Partial<ConversationListRow> = {};
  if (typeof body.title === "string") out.title = body.title;
  if (typeof body.pinned === "boolean") out.pinned = body.pinned ? 1 : 0;
  if (typeof body.favorite === "boolean") out.favorite = body.favorite ? 1 : 0;
  if (body.folderId === null || typeof body.folderId === "string") {
    out.folder_id = body.folderId;
  }
  return out;
}

export function folderPatchFromBody(
  body: Record<string, unknown>,
): Partial<FolderRow> {
  const out: Partial<FolderRow> = {};
  if (typeof body.name === "string") out.name = body.name;
  if (typeof body.pinned === "boolean") out.pinned = body.pinned ? 1 : 0;
  return out;
}

/**
 * ピン留めの中での上下移動を、サーバーと同じ手順で先に計算する
 * （`movePinnedItem`: 並びを 1..n に振り直してから隣と入れ替える）。
 * 手順を変えるなら両方を変える——食い違うと、取り直した一覧が着いた
 * ときに並びが一度跳ねる。端で動けないときは null。
 */
export function pinnedMovePatch(
  conversations: ConversationListRow[],
  folders: FolderRow[],
  type: "conversation" | "folder",
  id: string,
  direction: "up" | "down",
): OverlayPatch | null {
  const items = [
    ...folders
      .filter((f) => f.pinned)
      .map((f) => ({ type: "folder" as const, row: f })),
    ...conversations
      .filter((c) => c.pinned)
      .map((c) => ({ type: "conversation" as const, row: c })),
  ].sort(
    (a, b) =>
      a.row.sort_order - b.row.sort_order || a.row.created_at - b.row.created_at,
  );
  const index = items.findIndex((it) => it.type === type && it.row.id === id);
  if (index === -1) return null;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= items.length) return null;
  [items[index], items[target]] = [items[target], items[index]];
  const patch: OverlayPatch = { conversations: {}, folders: {} };
  items.forEach((it, i) => {
    const order = i + 1;
    if (it.row.sort_order === order) return;
    if (it.type === "folder") patch.folders[it.row.id] = { sort_order: order };
    else patch.conversations[it.row.id] = { sort_order: order };
  });
  return patch;
}
