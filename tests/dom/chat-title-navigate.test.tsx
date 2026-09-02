import { beforeEach, describe, expect, it } from "vitest";
import { createRoutesStub, Outlet, useLocation } from "react-router";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chat } from "../../app/components/Chat";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { installServer, msg, TEST_MODEL, type ServerStub } from "./helpers/chat-harness";

/**
 * 新規チャットの1通目が終わったあとの、後追いの遷移（監査 D-7）。
 *
 * 新規チャットは生成の追従を切らないため navigate せず URL だけ
 * 差し替えるので、React Router から見た現在地は "/" のまま残る。
 * それを会話ページへ合わせ直す遷移が、応答の確定とタイトル生成
 * （数秒かかる）のあとに走る。
 *
 * 問題は「まだ自分が最新か」の確認が**その数秒の前**にしか無いこと。
 * 待っているあいだに2通目を送ると、確認をすり抜けた遷移が後から効き、
 * 画面が作り直されて2通目の進行中表示ごと捨てられる。
 */

/** 好きなときに解決できる約束。タイトル生成の遅れを作るのに使う。 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

/** 遷移先の目印。ここが出ていれば会話ページへ移ったということ。 */
function ChatPage() {
  const { pathname } = useLocation();
  return <div data-testid="chat-page">会話ページ: {pathname}</div>;
}

let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

/** シェルの文脈込みで描く。 */
function renderChatHome() {
  const shell = {
    models: [TEST_MODEL],
    bots: [],
    usdJpy: 150,
    settings: DEFAULT_APP_SETTINGS,
    openSidebar: () => {},
  };
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ConfirmProvider>
          <Outlet context={shell} />
        </ConfirmProvider>
      ),
      children: [
        {
          index: true,
          Component: () => <Chat conversationId={null} initialMessages={[]} />,
        },
      ],
    },
    { path: "/chat/:id", Component: ChatPage },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

describe("1通目のあとの後追いの遷移", () => {
  it("そのまま待てば、会話ページへ合わせ直す", async () => {
    const user = renderChatHome();
    await user.type(await screen.findByRole("textbox"), "1通目");
    await user.keyboard("{Enter}");

    // 応答が確定し、タイトル生成も終わったら会話ページへ移る
    expect(await screen.findByTestId("chat-page")).toBeTruthy();
  }, 15000);

  /**
   * 自分で別の会話へ移っていたときも引き戻さない。新規会話の最初の応答で
   * 「ここから分岐」した直後に元の会話へ戻されるのが、これが無いときの症状。
   * URL は生成開始時に差し替え済みなので、そのままかどうかで見る。
   */
  it("自分で別の場所へ移っていたら、引き戻さない", async () => {
    const held = gate();
    server.on("/title", async () => {
      await held.promise;
      return { ok: true };
    });

    const user = renderChatHome();
    await user.type(await screen.findByRole("textbox"), "1通目");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("応答です")).toBeTruthy();

    // 利用者が自分で別の会話へ移った（URL が変わる）
    window.history.replaceState({}, "", "/chat/よその会話");
    held.open();

    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("chat-page")).toBeNull();
  }, 15000);

  it("タイトル生成を待つあいだに2通目を送ったら、遷移しない", async () => {
    const held = gate();
    server.on("/title", async () => {
      await held.promise;
      return { ok: true };
    });
    // 2通目は応答を返さないままにして、進行中で止める
    let holdGenerate = false;
    server.on("/generate", (body) => {
      const b = body as { userContent?: string };
      if (holdGenerate) return new Promise<never>(() => {});
      server.messages.push(msg("user", String(b.userContent), { id: "u-1" }));
      server.messages.push(msg("assistant", "応答です", { id: "a-1" }));
      return { userMessageId: "u-1", assistantMessageId: "a-1" };
    });

    const user = renderChatHome();
    const box = await screen.findByRole("textbox");
    await user.type(box, "1通目");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("応答です")).toBeTruthy();

    // ここでタイトル生成が保留のまま、2通目を送る
    holdGenerate = true;
    await user.type(box, "2通目");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("2通目")).toBeTruthy();

    // タイトル生成が返る。後追いの遷移はここで走ろうとする
    held.open();

    // 少し待っても遷移していない（＝2通目の画面が生き残っている）
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("chat-page")).toBeNull();
    expect(screen.getByText("2通目")).toBeTruthy();
  }, 15000);
});
