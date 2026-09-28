import { describe, expect, it } from "vitest";
import {
  applyOverlay,
  conversationPatchFromBody,
  folderPatchFromBody,
  pinnedMovePatch,
} from "../app/lib/sidebar-overlay";
import type { ConversationListRow, FolderRow } from "../app/lib/db.server";

/**
 * サイドバーの先出し（返事を待たずに一覧へ映す）の組み立て。
 *
 * 画面では「押したらすぐ変わる」ことしか見えないので、写し方の誤り
 * （真偽値のまま入れて `pinned === 1` に当たらない、など）は、
 * 取り直した一覧が着いた瞬間に**遅れて正しくなる**形でしか出ない——
 * つまり以前と同じ遅さに戻るだけで、誰も気づかない。
 */
const c = (
  id: string,
  extra: Partial<ConversationListRow> = {},
): ConversationListRow =>
  ({
    id,
    title: id,
    pinned: 0,
    favorite: 0,
    folder_id: null,
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
    ...extra,
  }) as ConversationListRow;
const f = (id: string, extra: Partial<FolderRow> = {}): FolderRow =>
  ({ id, name: id, pinned: 0, sort_order: 0, created_at: 0, ...extra }) as FolderRow;

describe("会話の PATCH の本文を行の形へ", () => {
  it("真偽値は 0/1、folderId は folder_id に写す", () => {
    expect(
      conversationPatchFromBody({ pinned: true, favorite: false, folderId: "f1" }),
    ).toEqual({ pinned: 1, favorite: 0, folder_id: "f1" });
    expect(conversationPatchFromBody({ pinned: false, favorite: true })).toEqual({
      pinned: 0,
      favorite: 1,
    });
  });

  it("フォルダから出す（null）も写す。無い項目は触らない", () => {
    expect(conversationPatchFromBody({ folderId: null })).toEqual({
      folder_id: null,
    });
    expect(conversationPatchFromBody({ title: "新しい名前" })).toEqual({
      title: "新しい名前",
    });
  });

  it("フォルダは名前とピン留め", () => {
    expect(folderPatchFromBody({ name: "仕事", pinned: true })).toEqual({
      name: "仕事",
      pinned: 1,
    });
  });
});

describe("一覧へ重ねる", () => {
  it("後から重ねたものが勝ち、触っていない行は同じ物のまま", () => {
    const rows = [c("a"), c("b")];
    const out = applyOverlay(rows, [
      { a: { title: "1回目" } },
      { a: { title: "2回目", pinned: 1 } },
    ]);
    expect(out[0]).toMatchObject({ title: "2回目", pinned: 1 });
    // 行の memo を壊さない
    expect(out[1]).toBe(rows[1]);
    // 元の一覧は書き換えない（ローダーのデータを汚すと、外したときに戻らない）
    expect(rows[0].title).toBe("a");
  });

  it("何も重ならなければ一覧そのものを返す", () => {
    const rows = [c("a")];
    expect(applyOverlay(rows, [])).toBe(rows);
    expect(applyOverlay(rows, [{ other: { title: "x" } }])).toBe(rows);
  });
});

describe("ピン留めの上下移動", () => {
  /** 重ねた後の並び（Sidebar と同じ並べ方）。 */
  function order(
    convs: ConversationListRow[],
    folders: FolderRow[],
    patch: ReturnType<typeof pinnedMovePatch>,
  ): string[] {
    const cs = applyOverlay(convs, [patch!.conversations]);
    const fs = applyOverlay(folders, [patch!.folders]);
    return [
      ...fs.filter((x) => x.pinned).map((x) => ({ id: `f:${x.id}`, row: x })),
      ...cs.filter((x) => x.pinned).map((x) => ({ id: `c:${x.id}`, row: x })),
    ]
      .sort(
        (a, b) =>
          a.row.sort_order - b.row.sort_order ||
          a.row.created_at - b.row.created_at,
      )
      .map((x) => x.id);
  }

  it("フォルダと会話が混ざっていても、隣と入れ替わる", () => {
    const convs = [
      c("x", { pinned: 1, sort_order: 0, created_at: 1 }),
      c("y", { pinned: 1, sort_order: 0, created_at: 3 }),
      c("unpinned", { sort_order: 0 }),
    ];
    const folders = [f("F", { pinned: 1, sort_order: 0, created_at: 2 })];
    // 並びは x, F, y（sort_order が同じなので作成順）
    const down = pinnedMovePatch(convs, folders, "conversation", "x", "down");
    expect(order(convs, folders, down)).toEqual(["f:F", "c:x", "c:y"]);
    const up = pinnedMovePatch(convs, folders, "conversation", "y", "up");
    expect(order(convs, folders, up)).toEqual(["c:x", "c:y", "f:F"]);
    // ピン留めしていない行には触らない
    expect(down!.conversations.unpinned).toBeUndefined();
  });

  it("端では動かない（null）", () => {
    const convs = [
      c("x", { pinned: 1, sort_order: 1 }),
      c("y", { pinned: 1, sort_order: 2 }),
    ];
    expect(pinnedMovePatch(convs, [], "conversation", "x", "up")).toBeNull();
    expect(pinnedMovePatch(convs, [], "conversation", "y", "down")).toBeNull();
    expect(pinnedMovePatch(convs, [], "conversation", "nope", "up")).toBeNull();
  });

  it("既に正しい番号の行は書かない（サーバーはこの差分だけを書く）", () => {
    const convs = [
      c("x", { pinned: 1, sort_order: 1 }),
      c("y", { pinned: 1, sort_order: 2 }),
      c("z", { pinned: 1, sort_order: 3 }),
    ];
    const p = pinnedMovePatch(convs, [], "conversation", "y", "down")!;
    expect(p.conversations).toEqual({
      y: { sort_order: 3 },
      z: { sort_order: 2 },
    });
  });
});
