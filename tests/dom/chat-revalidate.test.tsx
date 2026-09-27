import { beforeEach, describe, expect, it } from "vitest";
import {
  createRoutesStub,
  Link,
  Outlet,
  useRevalidator,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatRoute, {
  clientLoader,
  meta,
  shouldRevalidate,
} from "../../app/routes/chat.$id";
import { SHELL_ROUTE_ID } from "../../app/lib/conversation-title";
import { invalidateChat } from "../../app/lib/chat-cache";
import { RouteError } from "../../app/components/RouteError";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { installServer, msg, TEST_MODEL } from "./helpers/chat-harness";

/**
 * 会話画面のローダーを、同じ会話のままの取り直しでは走らせないこと。
 *
 * revalidator.revalidate() は生成の終わり・サイドバーの操作・一覧が
 * 動いたとき（送信1通につき2回以上）に呼ばれる。既定では開いている
 * 画面のローダーも全部走り直し、会話を丸ごと（全メッセージ）サーバーから
 * 引いていた。画面が使うのは開いた瞬間の本文とタイトルだけなので、
 * タイトルはシェルの一覧から取る——ここが外れると、サイドバーで名前を
 * 変えてもヘッダーが古いまま残る。
 */

const CHAT_ROUTE_ID = "routes/chat.$id";

function args(
  over: Partial<ShouldRevalidateFunctionArgs>,
): ShouldRevalidateFunctionArgs {
  const url = new URL("http://localhost/chat/c1");
  return {
    currentUrl: url,
    nextUrl: url,
    currentParams: { id: "c1" },
    nextParams: { id: "c1" },
    defaultShouldRevalidate: true,
    ...over,
  } as ShouldRevalidateFunctionArgs;
}

describe("shouldRevalidate", () => {
  it("同じ会話のままの取り直し（revalidate）では走らせない", () => {
    expect(shouldRevalidate(args({}))).toBe(false);
  });

  it("別の会話へ移るときは既定どおり走らせる", () => {
    expect(
      shouldRevalidate(
        args({
          nextUrl: new URL("http://localhost/chat/c2"),
          nextParams: { id: "c2" },
        }),
      ),
    ).toBe(true);
  });

  it("フォームの送信のあとは既定に任せる", () => {
    expect(shouldRevalidate(args({ formMethod: "POST" }))).toBe(true);
    expect(
      shouldRevalidate(
        args({ formMethod: "POST", defaultShouldRevalidate: false }),
      ),
    ).toBe(false);
  });
});

/** 会話の行。ChatRoute が読むものだけ埋める。 */
function row(id: string, title: string) {
  return {
    id,
    title,
    model_id: TEST_MODEL.id,
    bot_id: null,
    bot_name: null,
    bot_icon: null,
    system_prompt: null,
    params_json: null,
    pinned: 0,
    favorite: 0,
    folder_id: null,
    unread: 0,
    sort_order: 0,
    current_leaf_message_id: null,
    created_at: 1,
    updated_at: 1,
  };
}

interface World {
  /** シェルの一覧が持つタイトル（サイドバーで変えるとここが変わる）。 */
  shellTitles: Record<string, string>;
  /** サーバーの会話が持つタイトル。 */
  serverTitles: Record<string, string>;
  shellLoads: number;
  /** 会話を丸ごと引いた回数（本物の clientLoader がサーバーへ行った回数）。 */
  chatFetches: number;
  /** 次の会話の取得を失敗させる。 */
  failNext?: boolean;
}

function renderApp(world: World, path = "/chat/c1") {
  const shellContext = {
    models: [TEST_MODEL],
    bots: [],
    usdJpy: 150,
    settings: DEFAULT_APP_SETTINGS,
    openSidebar: () => {},
  };
  function ShellStub() {
    const revalidator = useRevalidator();
    return (
      <ConfirmProvider>
        <button type="button" onClick={() => void revalidator.revalidate()}>
          一覧を取り直す
        </button>
        <Link to="/chat/c2">べつの会話へ</Link>
        <span data-testid="state">{revalidator.state}</span>
        <Outlet context={shellContext} />
      </ConfirmProvider>
    );
  }
  const Stub = createRoutesStub([
    {
      id: SHELL_ROUTE_ID,
      path: "/",
      loader: () => {
        world.shellLoads++;
        return {
          conversations: Object.entries(world.shellTitles).map(([id, t]) =>
            row(id, t),
          ),
        };
      },
      Component: ShellStub,
      children: [
        {
          id: CHAT_ROUTE_ID,
          path: "chat/:id",
          // 本物の clientLoader（先読みの写し → 無ければサーバー）を通す
          loader: ({ params }) =>
            clientLoader({
              params,
              serverLoader: async () => {
                world.chatFetches++;
                if (world.failNext) {
                  world.failNext = false;
                  throw new Error("通信が途切れた");
                }
                return {
                  conversation: row(params.id!, world.serverTitles[params.id!]),
                  messages: [
                    msg("user", "質問", { id: `u-${params.id}` }),
                    msg("assistant", "答え", { id: `a-${params.id}` }),
                  ],
                };
              },
            } as never),
          shouldRevalidate,
          Component: ChatRoute as never,
          ErrorBoundary: RouteError,
        },
      ],
    },
  ]);
  render(<Stub initialEntries={[path]} />);
  return userEvent.setup();
}

/** 取り直しが終わるまで待つ。 */
async function revalidate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "一覧を取り直す" }));
  await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("idle"));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

let world: World;
beforeEach(() => {
  // 先読みの写しはモジュールに残る。前のテストの写しで数が狂わないように
  invalidateChat("c1");
  invalidateChat("c2");
  installServer();
  localStorage.clear();
  world = {
    shellTitles: { c1: "最初の名前", c2: "二つ目" },
    serverTitles: { c1: "最初の名前", c2: "二つ目" },
    shellLoads: 0,
    chatFetches: 0,
  };
});

describe("同じ会話のままの取り直し", () => {
  it("一覧は取り直すが、会話は丸ごと引き直さない", async () => {
    const user = renderApp(world);
    expect(await screen.findByText("最初の名前")).toBeInTheDocument();
    expect(await screen.findByText("答え")).toBeInTheDocument();
    const shellBefore = world.shellLoads;
    const chatBefore = world.chatFetches;

    await revalidate(user);
    await revalidate(user);

    // 取り直しそのものは起きている（シェルは2回走った）
    expect(world.shellLoads).toBe(shellBefore + 2);
    expect(world.chatFetches).toBe(chatBefore);
    expect(screen.getByText("答え")).toBeInTheDocument();
  });

  it("サイドバーで名前を変えたら、ヘッダーも変わる", async () => {
    const user = renderApp(world);
    expect(await screen.findByText("最初の名前")).toBeInTheDocument();

    world.shellTitles.c1 = "変えた名前";
    world.serverTitles.c1 = "変えた名前";
    await revalidate(user);

    expect(await screen.findByText("変えた名前")).toBeInTheDocument();
    expect(screen.queryByText("最初の名前")).toBeNull();
    // 会話を引き直して拾ったのではない
    expect(world.chatFetches).toBe(1);
  });

  it("別の会話へ移るときは引く", async () => {
    const user = renderApp(world);
    expect(await screen.findByText("最初の名前")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "べつの会話へ" }));
    expect(await screen.findByText("二つ目")).toBeInTheDocument();
    expect(world.chatFetches).toBe(2);
  });

  /**
   * 名前を変えても updated_at は動かないので、別の端末で変えた名前は
   * この端末の一覧には届かない（取り直されない）。会話を開いたときの
   * ローダーのほうが新しいので、そちらを出す。一覧を常に正とすると、
   * ここで古い名前に戻る。
   */
  it("一覧が古いままなら、開いたときに引いた名前を出す", async () => {
    world.shellTitles.c2 = "古い名前";
    world.serverTitles.c2 = "よそで変えた名前";
    const user = renderApp(world);
    expect(await screen.findByText("最初の名前")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "べつの会話へ" }));
    expect(await screen.findByText("よそで変えた名前")).toBeInTheDocument();
    expect(screen.queryByText("古い名前")).toBeNull();
  });
});

/**
 * 読み込みに失敗して受け皿が出ているときの「取り直す」も、同じ URL の
 * 取り直し（revalidate）。これまで止めてしまうと、押しても何も起きない
 * ボタンになる。React Router はデータの無いルートを shouldRevalidate を
 * 見ずに走らせるので効くはずだが、その前提が変わっても気づけるように。
 */
describe("読み込みに失敗したとき", () => {
  it("受け皿の「取り直す」で、会話を引き直す", async () => {
    world.failNext = true;
    const user = renderApp(world);
    expect(await screen.findByText("読み込めませんでした")).toBeInTheDocument();
    expect(world.chatFetches).toBe(1);

    await user.click(screen.getByRole("button", { name: "取り直す" }));
    expect(await screen.findByText("答え")).toBeInTheDocument();
    expect(world.chatFetches).toBe(2);
  });
});

describe("文書のタイトル（meta）", () => {
  it("一覧が取り直されたら一覧の名前、それまでは会話の名前", () => {
    const chat = { conversation: row("c1", "会話の名前"), messages: [] };
    const shellA = { conversations: [row("c1", "一覧の古い名前")] };
    const shellB = { conversations: [row("c1", "一覧の新しい名前")] };
    const call = (shell: unknown) =>
      (
        meta({
          loaderData: chat,
          matches: [{ id: SHELL_ROUTE_ID, loaderData: shell }],
        } as never) as { title: string }[]
      )[0].title;

    expect(call(shellA)).toBe("会話の名前 - Chat");
    expect(call(shellA)).toBe("会話の名前 - Chat");
    expect(call(shellB)).toBe("一覧の新しい名前 - Chat");
  });

  it("一覧に居ない（上限より古い）会話は、会話の名前", () => {
    const chat = { conversation: row("old", "古い会話"), messages: [] };
    const call = (shell: unknown) =>
      (
        meta({
          loaderData: chat,
          matches: [{ id: SHELL_ROUTE_ID, loaderData: shell }],
        } as never) as { title: string }[]
      )[0].title;
    call({ conversations: [] });
    expect(call({ conversations: [row("c1", "別")] })).toBe("古い会話 - Chat");
  });
});
