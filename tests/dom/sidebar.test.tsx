import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import {
  answerConfirm,
  answerPrompt,
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
    answerPrompt("新しい名前");
    const { user } = renderSidebar({ conversations: [conv("c1", "元の名前")] });
    await openMenu(user, "元の名前");
    await user.click(screen.getByRole("button", { name: "名前を変更" }));

    await waitFor(() => {
      expect(server.lastBody("/api/conversations/c1")).toEqual({
        title: "新しい名前",
      });
    });
  });

  it("名前の入力をやめたら何も送らない", async () => {
    answerPrompt(null);
    const { user } = renderSidebar({ conversations: [conv("c1", "元の名前")] });
    await openMenu(user, "元の名前");
    await user.click(screen.getByRole("button", { name: "名前を変更" }));
    expect(server.countOf("/api/conversations/c1")).toBe(0);
  });

  it("お気に入りを付け外しできる", async () => {
    const { user } = renderSidebar({ conversations: [conv("c1", "対象の会話")] });
    await openMenu(user, "対象の会話");
    await user.click(screen.getByRole("button", { name: "お気に入りに追加" }));
    await waitFor(() =>
      expect(server.lastBody("/api/conversations/c1")).toEqual({ favorite: true }),
    );
  });

  it("既にお気に入りなら、外す側が出る", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話", { favorite: 1 })],
    });
    await openMenu(user, "対象の会話");
    await user.click(screen.getByRole("button", { name: "お気に入りから外す" }));
    await waitFor(() =>
      expect(server.lastBody("/api/conversations/c1")).toEqual({ favorite: false }),
    );
  });

  it("ピン留めできる", async () => {
    const { user } = renderSidebar({ conversations: [conv("c1", "対象の会話")] });
    await openMenu(user, "対象の会話");
    await user.click(screen.getByRole("button", { name: "ピン留め" }));
    await waitFor(() =>
      expect(server.lastBody("/api/conversations/c1")).toEqual({ pinned: true }),
    );
  });

  it("削除は確認してから送る", async () => {
    answerConfirm(true);
    const { user } = renderSidebar({ conversations: [conv("c1", "消す会話")] });
    await openMenu(user, "消す会話");
    await user.click(screen.getByRole("button", { name: "削除" }));
    await waitFor(() => {
      const call = server.calls.find(
        (c) => c.path.includes("/api/conversations/c1") && c.method === "DELETE",
      );
      expect(call).toBeTruthy();
    });
  });

  it("確認でやめたら消さない", async () => {
    answerConfirm(false);
    const { user } = renderSidebar({ conversations: [conv("c1", "消さない会話")] });
    await openMenu(user, "消さない会話");
    await user.click(screen.getByRole("button", { name: "削除" }));
    expect(
      server.calls.some((c) => c.method === "DELETE"),
    ).toBe(false);
  });
});

describe("フォルダの操作", () => {
  it("作成するとサーバーへ送る", async () => {
    answerPrompt("新しいフォルダ");
    const { user } = renderSidebar({ conversations: [] });
    await user.click(screen.getByLabelText("フォルダを作成"));
    await waitFor(() =>
      expect(server.lastBody("/api/folders")).toEqual({ name: "新しいフォルダ" }),
    );
  });

  it("名前を変えられる", async () => {
    answerPrompt("経理");
    const { user } = renderSidebar({
      conversations: [],
      folders: [folder("f1", "仕事")],
    });
    await openMenu(user, "仕事");
    await user.click(screen.getByRole("button", { name: "名前を変更" }));
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
    answerPrompt("新しい名前");
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));

    expect(await screen.findByRole("status")).toHaveTextContent(/失敗/);
  });

  it("削除が失敗したら、そう出る", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
    });
    server.failAll(500);
    answerConfirm(true);
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("削除"));

    expect(await screen.findByRole("status")).toHaveTextContent(/失敗/);
  });

  it("成功したときは何も出さない", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
    });
    answerPrompt("新しい名前");
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));

    await waitFor(() => expect(server.countOf("/conversations/c1")).toBe(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("閉じられる", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
    });
    server.failAll(500);
    answerPrompt("新しい名前");
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));

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
    answerPrompt("新しい名前");
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));

    expect(await screen.findByRole("status")).toHaveTextContent(/失敗/);
  });

  it("次に成功したら消える", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
    });
    server.failAll(500);
    answerPrompt("一度目");
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));
    await screen.findByRole("status");

    server.succeed();
    answerPrompt("二度目");
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("名前を変更"));
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
    answerConfirm(true);
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("削除"));

    await screen.findByRole("status");
    expect(screen.getByTestId("here").textContent).toBe("/chat/c1");
  });

  it("削除に成功したら、その会話から移動する", async () => {
    const { user } = renderSidebar({
      conversations: [conv("c1", "対象の会話")],
      current: "c1",
    });
    answerConfirm(true);
    await openMenu(user, "対象の会話");
    await user.click(screen.getByText("削除"));

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
      answerConfirm(true);
      await openMenu(user, "仕事");
      await user.click(screen.getByText("削除"));

      await screen.findByRole("status");
      expect(screen.getByText("仕事")).toBeTruthy();
    })();
  });
});

