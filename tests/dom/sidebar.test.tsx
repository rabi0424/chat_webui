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
