import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import {
  answerDialog,
  answerRename,
  conv,
  folder,
  installSidebarServer,
  renderSidebar,
  type SidebarServer,
} from "./helpers/sidebar-harness";

/**
 * 会話一覧（サイドバー）。
 *
 * 一覧・フォルダ・ピン留め・お気に入り・検索と、それぞれに「…」メニューが
 * ぶら下がる。操作の結果はサーバーへ PATCH で伝えるので、何を送るかを見る。
 */
let server: SidebarServer;
beforeEach(() => {
  server = installSidebarServer();
  localStorage.clear();
});

/** 対象の行の「…」を開く。 */
async function openMenu(
  user: ReturnType<typeof renderSidebar>["user"],
  title: string,
) {
  const row = screen.getByText(title).closest("li") as HTMLElement;
  await user.click(within(row).getByLabelText("メニュー"));
  return row;
}

describe("一覧の表示", () => {
  it("会話が並ぶ", () => {
    renderSidebar({
      conversations: [conv("c1", "きのうの相談"), conv("c2", "今日の相談")],
    });
    expect(screen.getByText("きのうの相談")).toBeTruthy();
    expect(screen.getByText("今日の相談")).toBeTruthy();
  });

  it("未読の会話に印が付く", () => {
    renderSidebar({
      conversations: [conv("c1", "未読あり"), conv("c2", "既読")],
      unreadIds: new Set(["c1"]),
    });
    const unreadRow = screen.getByText("未読あり").closest("li") as HTMLElement;
    expect(within(unreadRow).getByLabelText("新しい応答があります")).toBeTruthy();
    const readRow = screen.getByText("既読").closest("li") as HTMLElement;
    expect(within(readRow).queryByLabelText("新しい応答があります")).toBeNull();
  });

  it("見ている会話には未読の印を出さない", () => {
    // 「成功するまで生成」は1件目の成功で印を立てる。見ている会話にも
    // 立つので、そのままだと開いている行にずっと印が残る
    renderSidebar({
      conversations: [conv("c1", "見ている"), conv("c2", "別の会話")],
      unreadIds: new Set(["c1", "c2"]),
      current: "c1",
    });
    const openRow = screen.getByText("見ている").closest("li") as HTMLElement;
    expect(within(openRow).queryByLabelText("新しい応答があります")).toBeNull();
    // 隣の会話には出ている（＝行そのものが描けていないのではない）
    const otherRow = screen.getByText("別の会話").closest("li") as HTMLElement;
    expect(
      within(otherRow).getByLabelText("新しい応答があります"),
    ).toBeTruthy();
  });

  it("生成中の会話はタイトルが光る", () => {
    renderSidebar({
      conversations: [conv("c1", "生成中の会話"), conv("c2", "止まっている")],
      generatingIds: new Set(["c1"]),
    });
    const running = screen.getByText("生成中の会話");
    expect(running.className).toContain("title-shimmer");
    // 見た目だけでは伝わらないので、状態は言葉でも置く
    const row = running.closest("li") as HTMLElement;
    expect(within(row).getByText("（生成中）")).toBeTruthy();

    const idle = screen.getByText("止まっている");
    expect(idle.className).not.toContain("title-shimmer");
    const idleRow = idle.closest("li") as HTMLElement;
    expect(within(idleRow).queryByText("（生成中）")).toBeNull();
  });

  it("生成中が分かっていないうちは、どれも光らせない", () => {
    // 印を引く前（null）に全部光らせると、開くたびに一覧が波打つ
    renderSidebar({
      conversations: [conv("c1", "まだ分からない会話")],
      generatingIds: null,
    });
    expect(screen.getByText("まだ分からない会話").className).not.toContain(
      "title-shimmer",
    );
  });

  it("会話は今日・昨日の見出しで区切られる", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 8, 2, 3, 0, 0); // 2026-09-02 12:00 JST
    renderSidebar({
      conversations: [
        conv("c1", "けさの会話", { updated_at: now - 60_000 }),
        conv("c2", "きのうの会話", { updated_at: now - DAY }),
        conv("c3", "先月の会話", { updated_at: now - 40 * DAY }),
      ],
      now,
    });
    const labels = screen
      .getAllByText(/^(今日|昨日|過去7日|過去30日|それ以前)$/)
      .map((el) => el.textContent);
    expect(labels).toEqual(["今日", "昨日", "それ以前"]);
    // 見出しと行の対応。「今日」の直後の一覧に「けさの会話」が居る
    const today = screen.getByText("今日").closest("div")!.parentElement!;
    expect(within(today).getByText("けさの会話")).toBeTruthy();
    expect(within(today).queryByText("きのうの会話")).toBeNull();
  });

  it("フォルダが並ぶ", () => {
    renderSidebar({
      conversations: [],
      folders: [folder("f1", "仕事")],
    });
    expect(screen.getByText("仕事")).toBeTruthy();
  });
});

describe("会話の操作", () => {
  it("名前を変えるとサーバーへ送る", async () => {
    const { user } = renderSidebar({ conversations: [conv("c1", "元の名前")] });
    await openMenu(user, "元の名前");
    await user.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    // 行そのものが入力欄に変わる（ブラウザの prompt は出ない）
    expect(screen.queryByText("元の名前")).toBeNull();
    await answerRename(user, "新しい名前");

    await waitFor(() => {
      expect(server.lastBody("/api/conversations/c1")).toEqual({
        title: "新しい名前",
      });
    });
  });

  it("名前の入力をやめたら何も送らず、元の名前に戻る", async () => {
    const { user } = renderSidebar({ conversations: [conv("c1", "元の名前")] });
    await openMenu(user, "元の名前");
    await user.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    await answerRename(user, null);
    expect(server.writesTo("/api/conversations/c1")).toBe(0);
    expect(screen.getByText("元の名前")).toBeTruthy();
  });

  it("同じ名前で確定しても送らない", async () => {
    const { user } = renderSidebar({ conversations: [conv("c1", "元の名前")] });
    await openMenu(user, "元の名前");
    await user.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    await answerRename(user, "元の名前");
    expect(server.writesTo("/api/conversations/c1")).toBe(0);
  });

  it("お気に入りを付け外しできる", async () => {
    const { user } = renderSidebar({ conversations: [conv("c1", "対象の会話")] });
    await openMenu(user, "対象の会話");
    await user.click(screen.getByRole("menuitem", { name: "お気に入りに追加" }));
    await waitFor(() =>
      expect(server.lastBody("/api/conversations/c1")).toEqual({ favorite: true }),
    );
  });

  it("既にお気に入りなら、外す側が出る", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話", { favorite: 1 })],
    });
    await openMenu(user, "対象の会話");
    await user.click(screen.getByRole("menuitem", { name: "お気に入りから外す" }));
    await waitFor(() =>
      expect(server.lastBody("/api/conversations/c1")).toEqual({ favorite: false }),
    );
  });

  it("ピン留めできる", async () => {
    const { user } = renderSidebar({ conversations: [conv("c1", "対象の会話")] });
    await openMenu(user, "対象の会話");
    await user.click(screen.getByRole("menuitem", { name: "ピン留め" }));
    await waitFor(() =>
      expect(server.lastBody("/api/conversations/c1")).toEqual({ pinned: true }),
    );
  });

  it("削除は確認してから送る", async () => {
    const { user } = renderSidebar({ conversations: [conv("c1", "消す会話")] });
    await openMenu(user, "消す会話");
    await user.click(screen.getByRole("menuitem", { name: "削除" }));
    // 確認が出るまでは送らない
    expect(server.calls.some((c) => c.method === "DELETE")).toBe(false);
    await answerDialog(user, true);
    await waitFor(() => {
      const call = server.calls.find(
        (c) => c.path.includes("/api/conversations/c1") && c.method === "DELETE",
      );
      expect(call).toBeTruthy();
    });
  });

  it("確認でやめたら消さない", async () => {
    const { user } = renderSidebar({ conversations: [conv("c1", "消さない会話")] });
    await openMenu(user, "消さない会話");
    await user.click(screen.getByRole("menuitem", { name: "削除" }));
    await answerDialog(user, false);
    expect(
      server.calls.some((c) => c.method === "DELETE"),
    ).toBe(false);
    // ダイアログは閉じ、行は残る
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("消さない会話")).toBeTruthy();
  });

  it("ブラウザの confirm は使わない", async () => {
    const spy = vi.spyOn(window, "confirm");
    const { user } = renderSidebar({ conversations: [conv("c1", "消す会話")] });
    await openMenu(user, "消す会話");
    await user.click(screen.getByRole("menuitem", { name: "削除" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("フォルダの操作", () => {
  it("作成するとサーバーへ送る", async () => {
    const { user } = renderSidebar({ conversations: [] });
    await user.click(screen.getByLabelText("フォルダを作成"));
    await answerRename(user, "新しいフォルダ");
    await waitFor(() =>
      expect(server.lastBody("/api/folders")).toEqual({ name: "新しいフォルダ" }),
    );
  });

  it("名前を変えられる", async () => {
    const { user } = renderSidebar({
      conversations: [],
      folders: [folder("f1", "仕事")],
    });
    await openMenu(user, "仕事");
    await user.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    await answerRename(user, "経理");
    await waitFor(() =>
      expect(server.lastBody("/api/folders/f1")).toEqual({ name: "経理" }),
    );
  });
});

/**
 * フォルダとお気に入りは、行の中に別の行（会話）を入れ子にする。
 * 中身は Sidebar 本体から文脈で配られるので、配線が外れると
 * 「開いても空」「件数が0のまま」という形で静かに壊れる。
 */
describe("フォルダの中身", () => {
  it("展開すると、そのフォルダの会話だけが出る", async () => {
    const { user } = renderSidebar({
      conversations: [
        conv("c1", "中の会話", { folder_id: "f1" }),
        conv("c2", "外の会話"),
      ],
      folders: [folder("f1", "仕事")],
    });
    const row = screen.getByText("仕事").closest("li") as HTMLElement;
    expect(within(row).queryByText("中の会話")).toBeNull();

    await user.click(within(row).getByLabelText("展開"));
    expect(within(row).getByText("中の会話")).toBeTruthy();
    expect(within(row).queryByText("外の会話")).toBeNull();
  });

  it("行に中の件数が出る", () => {
    renderSidebar({
      conversations: [
        conv("c1", "1つめ", { folder_id: "f1" }),
        conv("c2", "2つめ", { folder_id: "f1" }),
        conv("c3", "よその会話"),
      ],
      folders: [folder("f1", "仕事")],
    });
    const row = screen.getByText("仕事").closest("li") as HTMLElement;
    expect(within(row).getByText("2")).toBeTruthy();
  });

  it("空のフォルダを展開すると、空だと分かる", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "よその会話")],
      folders: [folder("f1", "仕事")],
    });
    const row = screen.getByText("仕事").closest("li") as HTMLElement;
    await user.click(within(row).getByLabelText("展開"));
    expect(within(row).getByText("（空のフォルダ）")).toBeTruthy();
  });

  it("名前を押すと、そのフォルダの階層に入る", async () => {
    const { user } = renderSidebar({
      conversations: [
        conv("c1", "中の会話", { folder_id: "f1" }),
        conv("c2", "外の会話"),
      ],
      folders: [folder("f1", "仕事")],
    });
    await user.click(screen.getByText("仕事"));
    expect(screen.getByLabelText("戻る")).toBeTruthy();
    expect(screen.getByText("中の会話")).toBeTruthy();
    expect(screen.queryByText("外の会話")).toBeNull();
  });
});

describe("お気に入りフォルダ", () => {
  /** 常設の「お気に入り」の行。他のフォルダと違い消せないので目印で引く。 */
  const favoritesRow = () =>
    screen
      .getByTitle("お気に入り（削除できない常設フォルダ）")
      .closest("li") as HTMLElement;

  it("展開すると、お気に入りの会話だけが出る", async () => {
    const { user } = renderSidebar({
      conversations: [
        conv("c1", "お気に入りの会話", { favorite: 1 }),
        conv("c2", "ふつうの会話"),
      ],
    });
    const row = favoritesRow();
    await user.click(within(row).getByLabelText("展開"));
    expect(within(row).getByText("お気に入りの会話")).toBeTruthy();
    expect(within(row).queryByText("ふつうの会話")).toBeNull();
  });

  it("行に件数が出る", () => {
    renderSidebar({
      conversations: [
        conv("c1", "1つめ", { favorite: 1 }),
        conv("c2", "2つめ", { favorite: 1 }),
        conv("c3", "ふつうの会話"),
      ],
    });
    expect(within(favoritesRow()).getByText("2")).toBeTruthy();
  });

  it("1つも無ければ、空だと分かる", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "ふつうの会話")],
    });
    const row = favoritesRow();
    await user.click(within(row).getByLabelText("展開"));
    expect(within(row).getByText("（まだありません）")).toBeTruthy();
  });

  it("名前を押すと、お気に入りの階層に入る", async () => {
    const { user } = renderSidebar({
      conversations: [
        conv("c1", "お気に入りの会話", { favorite: 1 }),
        conv("c2", "ふつうの会話"),
      ],
    });
    await user.click(screen.getByTitle("お気に入り（削除できない常設フォルダ）"));
    expect(screen.getByLabelText("戻る")).toBeTruthy();
    expect(screen.getByText("お気に入りの会話")).toBeTruthy();
    expect(screen.queryByText("ふつうの会話")).toBeNull();
  });

  it("階層表示から専用ページへ行ける", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "お気に入りの会話", { favorite: 1 })],
    });
    await user.click(screen.getByTitle("お気に入り（削除できない常設フォルダ）"));
    expect(
      screen.getByLabelText("お気に入りのページを開く").getAttribute("href"),
    ).toBe("/favorites");
  });
});

/**
 * お気に入りは全件。
 *
 * ローダーの一覧は最新200件で切られているので、お気に入りはその外にも
 * ある。件数はローダーが数えて持ってきたものを出し、中身は開いたときに
 * 取りに行く。
 */
describe("お気に入りの全件", () => {
  const favoritesRow = () =>
    screen
      .getByTitle("お気に入り（削除できない常設フォルダ）")
      .closest("li") as HTMLElement;
  /** 200件の外にある（ローダーの一覧には無い）お気に入り。 */
  const outside = () =>
    conv("old", "一覧の外のお気に入り", { favorite: 1, updated_at: 1 });

  it("件数はローダーが数えた全件で、一覧の中を数えたものではない", () => {
    renderSidebar({
      conversations: [conv("c1", "手元のお気に入り", { favorite: 1 })],
      favoriteCount: 7,
    });
    expect(within(favoritesRow()).getByText("7")).toBeTruthy();
    expect(within(favoritesRow()).queryByText("1")).toBeNull();
  });

  it("開く前は取りに行かない", () => {
    renderSidebar({
      conversations: [conv("c1", "手元のお気に入り", { favorite: 1 })],
      favoriteCount: 2,
    });
    expect(server.countOf("/api/conversations/favorites")).toBe(0);
  });

  it("展開すると全件を取り、一覧の外のお気に入りも並ぶ（同じ会話は二重にしない）", async () => {
    server.onFavorites(() => ({
      conversations: [
        conv("c1", "手元のお気に入り", { favorite: 1 }),
        outside(),
      ],
    }));
    const { user } = renderSidebar({
      conversations: [
        conv("c1", "手元のお気に入り", { favorite: 1 }),
        conv("c2", "ふつうの会話"),
      ],
      favoriteCount: 2,
    });
    const row = favoritesRow();
    await user.click(within(row).getByLabelText("展開"));
    expect(await within(row).findByText("一覧の外のお気に入り")).toBeTruthy();
    expect(within(row).getAllByText("手元のお気に入り")).toHaveLength(1);
    expect(within(row).queryByText("ふつうの会話")).toBeNull();
    expect(server.countOf("/api/conversations/favorites")).toBe(1);
  });

  it("届くまでは手元の分を出し、残りを読んでいると分かる", async () => {
    let deliver: (() => void) | null = null;
    server.onFavorites(
      () =>
        new Promise((resolve) => {
          deliver = () => resolve({ conversations: [outside()] });
        }),
    );
    const { user } = renderSidebar({
      conversations: [conv("c1", "手元のお気に入り", { favorite: 1 })],
      favoriteCount: 2,
    });
    const row = favoritesRow();
    await user.click(within(row).getByLabelText("展開"));
    // 手元の分は待たずに出る
    expect(within(row).getByText("手元のお気に入り")).toBeTruthy();
    expect(within(row).getByText("残りを読み込み中…")).toBeTruthy();
    deliver!();
    expect(await within(row).findByText("一覧の外のお気に入り")).toBeTruthy();
    expect(within(row).queryByText("残りを読み込み中…")).toBeNull();
  });

  it("取れなかったら、手元の分を出したまま失敗を伝える", async () => {
    server.failAll(500);
    const { user } = renderSidebar({
      conversations: [conv("c1", "手元のお気に入り", { favorite: 1 })],
      favoriteCount: 2,
    });
    const row = favoritesRow();
    await user.click(within(row).getByLabelText("展開"));
    expect(
      await screen.findByText("お気に入りの読み込みに失敗しました"),
    ).toBeTruthy();
    expect(within(row).getByText("手元のお気に入り")).toBeTruthy();
    // 「読み込み中」のまま残さない（もう来ない）
    expect(within(row).queryByText("残りを読み込み中…")).toBeNull();
  });

  it("一覧の外のお気に入りを外すと、押した時点で行が消えて件数が減る", async () => {
    server.onFavorites(() => ({ conversations: [outside()] }));
    const { user } = renderSidebar({
      conversations: [conv("c1", "手元のお気に入り", { favorite: 1 })],
      favoriteCount: 2,
    });
    const row = favoritesRow();
    await user.click(within(row).getByLabelText("展開"));
    const target = (await within(row).findByText("一覧の外のお気に入り")).closest(
      "li",
    ) as HTMLElement;
    await user.click(within(target).getByLabelText("メニュー"));
    await user.click(screen.getByRole("menuitem", { name: "お気に入りから外す" }));
    expect(server.lastBody("/api/conversations/old")).toEqual({ favorite: false });
    await waitFor(() =>
      expect(within(row).queryByText("一覧の外のお気に入り")).toBeNull(),
    );
    expect(within(row).getByText("1")).toBeTruthy();
    expect(within(row).getByText("手元のお気に入り")).toBeTruthy();
  });
});

/**
 * 開いたものが Escape で閉じるか。
 *
 * フック単体の挙動は dismiss.test が見ている。ここが見るのは配線——
 * 呼び忘れても型は通り、キーボードで閉じられないまま残る。
 */
describe("Escape で閉じる", () => {
  it("「…」メニューが閉じる", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
    });
    await openMenu(user, "対象の会話");
    expect(screen.getByText("名前を変更")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByText("名前を変更")).toBeNull();
  });

  it("フォルダ移動のモーダルが閉じる", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
      folders: [folder("f1", "仕事")],
    });
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("フォルダへ移動…"));
    expect(screen.getByText(/をフォルダへ移動/)).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByText(/をフォルダへ移動/)).toBeNull();
  });
});

/**
 * 操作が失敗したとき。
 *
 * これまでは fetch を .catch(() => {}) で握りつぶしていた。名前を変えた
 * つもりが変わっていない・消したつもりが残っている、という結果だけが
 * 残り、しかも一覧は取り直されるので**元に戻ったように見える**。
 */
describe("操作の失敗", () => {
  it("名前の変更が失敗したら、そう出る", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
    });
    server.failAll(500);
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));
    await answerRename(user, "新しい名前");

    expect(await screen.findByRole("status")).toHaveTextContent(/失敗/);
  });

  it("削除が失敗したら、そう出る", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
    });
    server.failAll(500);
    await openMenu(user, "対象の会話");
    await user.click(screen.getByRole("menuitem", { name: "削除" }));
    await answerDialog(user, true);

    expect(await screen.findByRole("status")).toHaveTextContent(/失敗/);
  });

  it("成功したときは何も出さない", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
    });
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));
    await answerRename(user, "新しい名前");

    await waitFor(() => expect(server.writesTo("/conversations/c1")).toBe(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("閉じられる", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
    });
    server.failAll(500);
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));
    await answerRename(user, "新しい名前");

    await screen.findByRole("status");
    await user.click(screen.getByLabelText("閉じる"));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("操作の失敗（続き）", () => {
  it("通信そのものが切れた場合も伝える", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
    });
    server.throwAll();
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));
    await answerRename(user, "新しい名前");

    expect(await screen.findByRole("status")).toHaveTextContent(/失敗/);
  });

  it("次に成功したら消える", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
    });
    server.failAll(500);
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));
    await answerRename(user, "一度目");
    await screen.findByRole("status");

    server.succeed();
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));
    await answerRename(user, "二度目");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  /** 消せていないのに画面だけ移ると、消えたように見えてしまう。 */
  it("削除に失敗したら、その会話から移動しない", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
      current: "c1",
    });
    expect(screen.getByTestId("here").textContent).toBe("/chat/c1");

    server.failAll(500);
    await openMenu(user, "対象の会話");
    await user.click(screen.getByRole("menuitem", { name: "削除" }));
    await answerDialog(user, true);

    await screen.findByRole("status");
    expect(screen.getByTestId("here").textContent).toBe("/chat/c1");
  });

  it("削除に成功したら、その会話から移動する", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
      current: "c1",
    });
    await openMenu(user, "対象の会話");
    await user.click(screen.getByRole("menuitem", { name: "削除" }));
    await answerDialog(user, true);

    await waitFor(() =>
      expect(screen.getByTestId("here").textContent).toBe("/"),
    );
  });
  it("フォルダの削除に失敗したら、フォルダは残る", () => {
    // 消えたように見せない。一覧は取り直されるので、失敗していれば行は戻る
    return (async () => {
      const { user } = renderSidebar({
        conversations: [],
        folders: [folder("f1", "仕事")],
      });
      server.failAll(500);
      await openMenu(user, "仕事");
      await user.click(screen.getByRole("menuitem", { name: "削除" }));
      await answerDialog(user, true);

      await screen.findByRole("status");
      expect(screen.getByText("仕事")).toBeTruthy();
    })();
  });
});


/**
 * 検索の連打。
 *
 * 打つのを止めた分は待つが、それでも要求は並びうる（前の語の検索が
 * 遅いと、後の語の結果が先に返る）。古いほうが後に返ると、いま入って
 * いる語と合わない結果が残る。
 */
/**
 * 虫眼鏡を押した直後、待たずに検索欄へフォーカスが入っているか。
 *
 * iPhone は利用者の操作の中で呼ばれた focus() でしかキーボードを出さない。
 * 描画を待ってから（requestAnimationFrame で）フォーカスすると、押した
 * 操作の外になってキーボードが出なかった。ここでは「クリックが返った
 * 時点で」入っていることを見る——フレームを待つ実装なら、この時点では
 * まだ入っていない。
 */
describe("検索欄を開く", () => {
  it("押した操作の中で検索欄にフォーカスが入る", async () => {
    const { user } = renderSidebar({ conversations: [] });
    await user.click(screen.getByLabelText("会話を検索"));
    const box = screen.getByRole("textbox", { name: "会話を検索" });
    expect(document.activeElement).toBe(box);
  });
});

describe("検索結果の印", () => {
  it("お気に入りの会話には、一覧と同じ★が付く", async () => {
    const { user } = renderSidebar({ conversations: [] });
    server.onSearch(() => ({
      results: [
        { id: "r1", title: "お気に入りの結果", favorite: 1, snippet: null },
        { id: "r2", title: "ふつうの結果", favorite: 0, snippet: null },
      ],
    }));
    await user.click(screen.getByLabelText("会話を検索"));
    // 題名に含まれない語で探す（含まれると太字で分割され、文字列で引けない）
    await user.type(screen.getByLabelText("会話を検索"), "x");
    const starred = (await screen.findByText("お気に入りの結果")).closest(
      "li",
    ) as HTMLElement;
    expect(within(starred).getByLabelText("お気に入り")).toBeTruthy();
    const plain = screen.getByText("ふつうの結果").closest("li") as HTMLElement;
    expect(within(plain).queryByLabelText("お気に入り")).toBeNull();
  });
});

describe("検索の順序", () => {
  it("古い結果が後から返っても、最新の語の結果が残る", async () => {
    const { user } = renderSidebar({ conversations: [] });
    await user.click(screen.getByLabelText("会話を検索"));
    const box = screen.getByLabelText("会話を検索");

    let releaseFirst: (() => void) | null = null;
    let nth = 0;
    server.onSearch((q) => {
      nth++;
      const body = { results: [{ id: `r${nth}`, title: `${q} の結果` }] };
      if (nth === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve(body);
        });
      }
      return body;
    });

    await user.type(box, "あ");
    await new Promise((r) => setTimeout(r, 350));
    await user.type(box, "い");
    await new Promise((r) => setTimeout(r, 350));

    await waitFor(() =>
      expect(document.body.textContent).toContain("あい の結果"),
    );

    releaseFirst?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.body.textContent).toContain("あい の結果");
    expect(document.body.textContent).not.toContain("あ の結果");
  });
});

/**
 * フォルダの開閉状態。
 *
 * スマホのドロワーは閉じるたびに外される。状態を中に持っていたので、
 * 開き直すたびにフォルダが畳まれ、**中を見るには毎回開き直す**ことに
 * なっていた。保存して持ち回る形にした。
 */
describe("フォルダの開閉が残る", () => {
  it("開いた状態が保存される", async () => {
    const { user, unmount } = renderSidebar({
      conversations: [conv("c1", "中の会話", { folder_id: "f1" })],
      folders: [folder("f1", "仕事")],
    });
    const row = () => screen.getByText("仕事").closest("li") as HTMLElement;
    await user.click(within(row()).getByLabelText("展開"));
    expect(within(row()).getByText("中の会話")).toBeTruthy();

    // ドロワーが閉じて外される、に相当
    unmount();

    renderSidebar({
      conversations: [conv("c1", "中の会話", { folder_id: "f1" })],
      folders: [folder("f1", "仕事")],
    });
    // 開いたまま
    expect(screen.getByText("中の会話")).toBeTruthy();
  });

  it("畳んだ状態も残る", async () => {
    const { user, unmount } = renderSidebar({
      conversations: [conv("c1", "中の会話", { folder_id: "f1" })],
      folders: [folder("f1", "仕事")],
    });
    const row = () => screen.getByText("仕事").closest("li") as HTMLElement;
    await user.click(within(row()).getByLabelText("展開"));
    await user.click(within(row()).getByLabelText("折りたたむ"));
    unmount();

    renderSidebar({
      conversations: [conv("c1", "中の会話", { folder_id: "f1" })],
      folders: [folder("f1", "仕事")],
    });
    expect(screen.queryByText("中の会話")).toBeNull();
  });

  it("読めない保存値は、畳んだ状態として扱う", () => {
    localStorage.setItem("chat-webui:expanded-folders", "{壊れている");
    renderSidebar({
      conversations: [conv("c1", "中の会話", { folder_id: "f1" })],
      folders: [folder("f1", "仕事")],
    });
    expect(screen.queryByText("中の会話")).toBeNull();
    expect(screen.getByText("仕事")).toBeTruthy();
  });

  /**
   * JSON としては読めるが形が違うもの。前のバージョンが書いた値や、
   * 手で書き換えたものがこの形になる。読めてしまうぶん、素通りしやすい。
   */
  it("形の違う保存値も、畳んだ状態として扱う", () => {
    localStorage.setItem(
      "chat-webui:expanded-folders",
      JSON.stringify({ f1: true }),
    );
    renderSidebar({
      conversations: [conv("c1", "中の会話", { folder_id: "f1" })],
      folders: [folder("f1", "仕事")],
    });
    // 「畳んでいる」と「そもそも描けていない」は、queryByText では
    // 区別が付かない。一覧が出ていることも確かめる
    expect(screen.getByText("仕事")).toBeTruthy();
    expect(screen.queryByText("中の会話")).toBeNull();
  });

  it("配列だが中身が文字列でないものも同じ", () => {
    localStorage.setItem("chat-webui:expanded-folders", JSON.stringify([1, 2]));
    renderSidebar({
      conversations: [conv("c1", "中の会話", { folder_id: "f1" })],
      folders: [folder("f1", "仕事")],
    });
    expect(screen.getByText("仕事")).toBeTruthy();
    expect(screen.queryByText("中の会話")).toBeNull();
  });
});
