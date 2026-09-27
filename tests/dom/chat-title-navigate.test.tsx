import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRoutesStub,
  Outlet,
  useLoaderData,
  useLocation,
} from "react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";
import { Chat } from "../../app/components/Chat";
import ChatRoute, {
  clientLoader,
  shouldRevalidate,
} from "../../app/routes/chat.$id";
import { shouldRevalidate as shellShouldRevalidate } from "../../app/routes/shell";
import { SHELL_ROUTE_ID } from "../../app/lib/conversation-title";
import { invalidateChat } from "../../app/lib/chat-cache";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { installServer, msg, TEST_MODEL, type ServerStub } from "./helpers/chat-harness";

/**
 * 素のテキストの段（PlainMessages）が描かれた回数。
 *
 * 会話ページへ合わせ直したあとの画面が、整形前の段落を1枚挟んでから
 * Markdown に切り替わっていないかを見る。画面の上では一瞬なので、
 * 描いた回数を数えないと分からない。
 */
const plain = vi.hoisted(() => ({ renders: 0 }));
vi.mock("../../app/components/chat/PlainMessages", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../app/components/chat/PlainMessages")>();
  return {
    ...real,
    PlainMessages: (props: Parameters<typeof real.PlainMessages>[0]) => {
      plain.renders++;
      return real.PlainMessages(props);
    },
  };
});

/**
 * 新規チャットの1通目が終わったあとの、会話ページへの合わせ直し。
 *
 * 新規チャットは生成の追従を切らないため navigate せず URL だけ
 * 差し替えるので、React Router から見た現在地は "/" のまま残る。
 * 確定したあとで会話ページへ合わせ直す。
 *
 * 以前はこの前に「確定した応答の取り直し」と「タイトル生成（上流の
 * モデルへの往復で数秒）」を待ち、遷移してから会話を丸ごと引き直して
 * いた。読み始めた本文が数秒後に作り直されてちらつき、付いた名前は
 * サイドバーに届かないことがあった。
 */

const CONV = "c-new";

/** 好きなときに解決できる約束。応答の遅れを作るのに使う。 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

/** 会話の行。ChatRoute とサイドバーが読むものだけ埋める。 */
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
  /** サーバーの会話のタイトル（シェルの一覧もここから引く）。 */
  titles: Record<string, string>;
  /** 会話ページのローダーがサーバーまで行った回数。 */
  chatFetches: number;
}

let server: ServerStub;
let world: World;

beforeEach(() => {
  server = installServer();
  world = { titles: {}, chatFetches: 0 };
  plain.renders = 0;
  // 先読みの写しはモジュールに残る。前のテストの写しで結果が狂わないように
  invalidateChat(CONV);
  localStorage.clear();
  window.history.replaceState({}, "", "/");

  /*
   * 会話の作成だけは決まったIDで返し、一覧（world）にも載せる。
   * 本物と同じく、仮の名前は1通目の本文。
   */
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST" && path === "/api/conversations") {
      server.calls.push({ method: "POST", path, body: null });
      const body = JSON.parse(String(init.body)) as { title: string };
      world.titles[CONV] = body.title;
      return new Response(JSON.stringify({ id: CONV }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return base(input, init);
  }) as typeof fetch;

  // 名付け: サーバーは名前を書いてから返す
  server.on("/title", () => {
    world.titles[CONV] = "付いた名前";
    return { title: "付いた名前" };
  });
  // 会話をまとめて読む入口（先読みと同じ形）
  server.on("/full", () => ({
    conversation: row(CONV, world.titles[CONV]),
    messages: [...server.messages],
  }));
});

/** シェル（一覧つき）の中に、ホームと会話ページを置く。 */
function renderApp(path = "/") {
  const shellContext = {
    models: [TEST_MODEL],
    bots: [],
    usdJpy: 150,
    settings: DEFAULT_APP_SETTINGS,
    openSidebar: () => {},
  };
  function ShellStub() {
    const { conversations } = useLoaderData() as {
      conversations: { id: string; title: string }[];
    };
    const { pathname } = useLocation();
    return (
      <ConfirmProvider>
        {/* React Router から見た現在地（合わせ直したかどうか） */}
        <span data-testid="where">{pathname}</span>
        <ul data-testid="sidebar">
          {conversations.map((c) => (
            <li key={c.id}>{c.title}</li>
          ))}
        </ul>
        <Outlet context={shellContext} />
      </ConfirmProvider>
    );
  }
  const Stub = createRoutesStub([
    {
      id: SHELL_ROUTE_ID,
      path: "/",
      loader: () => ({
        conversations: Object.entries(world.titles).map(([id, t]) => row(id, t)),
      }),
      // 本物と同じく、遷移では一覧を取り直さない（取り直すと、写しの
      // 古い名前が一覧の新しい名前に負けて、見るべき食い違いが隠れる）
      shouldRevalidate: shellShouldRevalidate,
      Component: ShellStub,
      children: [
        {
          index: true,
          Component: () => <Chat conversationId={null} initialMessages={[]} />,
        },
        {
          id: "routes/chat.$id",
          path: "chat/:id",
          // 本物の clientLoader（先読みの写し → 無ければサーバー）を通す
          loader: ({ params }) =>
            clientLoader({
              params,
              serverLoader: async () => {
                world.chatFetches++;
                return {
                  conversation: row(params.id!, world.titles[params.id!]),
                  messages: [...server.messages],
                };
              },
            } as never),
          shouldRevalidate,
          Component: ChatRoute as never,
        },
      ],
    },
  ]);
  render(<Stub initialEntries={[path]} />);
  return userEvent.setup();
}

async function sendFirst(user: ReturnType<typeof userEvent.setup>, text = "1通目") {
  await user.type(await screen.findByRole("textbox"), text);
  await user.keyboard("{Enter}");
}

/** 会話ページへ合わせ直すまで待つ。 */
async function arrived() {
  await waitFor(() =>
    expect(screen.getByTestId("where").textContent).toBe(`/chat/${CONV}`),
  );
}

/** ツールバーの中央に出ている会話の名前。 */
function headerTitle(): string | null {
  return document.querySelector("p.truncate.font-semibold")?.textContent ?? null;
}

const sidebar = () => within(screen.getByTestId("sidebar"));

describe("1通目のあとの合わせ直し", () => {
  it("そのまま待てば、会話ページへ合わせ直す", async () => {
    const user = renderApp();
    await sendFirst(user);
    await arrived();
    // 移った先で本文が出ている（空の画面に差し替わったのではない）
    expect(await screen.findByText("応答です")).toBeInTheDocument();
  }, 15000);

  it("確定した応答を取り直さず、名付けにはポーリングで受け取った本文を使う", async () => {
    const user = renderApp();
    await sendFirst(user);
    await arrived();
    await waitFor(() => expect(server.countOf("/title")).toBe(1));

    // ポーリングは `?since=` 付き。付かない GET は確定後の取り直し
    const refetches = server.calls.filter(
      (c) => c.method === "GET" && /\/messages\/[^?]+$/.test(c.path),
    );
    expect(refetches).toEqual([]);
    // 追いかけ自体は走っていた（ここが0だと上の検査は何も見ていない）
    expect(server.countOf("/messages/")).toBeGreaterThan(0);
    expect(server.lastBody("/title")).toEqual({
      userText: "1通目",
      assistantText: "応答です",
    });
  }, 15000);

  it("名付けの返事を待たずに会話ページへ移る", async () => {
    // 名付けは返ってこないまま
    server.on("/title", () => new Promise<never>(() => {}));
    const user = renderApp();
    await sendFirst(user);

    await arrived();
    // 名付けは頼んである（頼まずに移ったのではない）
    expect(server.countOf("/title")).toBe(1);
  }, 15000);

  it("移った先では会話を引き直さない（写しから開く）", async () => {
    const user = renderApp();
    await sendFirst(user);
    await arrived();
    expect(await screen.findByText("応答です")).toBeInTheDocument();

    // 会話ページのローダーはサーバーへ行っていない
    expect(world.chatFetches).toBe(0);
    // 写しの元は遷移の前に1回だけ読んだもの
    expect(server.countOf("/full")).toBe(1);
  }, 15000);

  it("作り直した画面は、素のテキストの段を挟まない", async () => {
    // 名前は仮のままにしておく（ヘッダーで作り直した画面を見分けるため）
    server.on("/title", () => new Promise<never>(() => {}));
    const user = renderApp();
    await sendFirst(user);
    await arrived();
    // 会話ページの Chat が描けている（落ちて何も出ていないのではない）
    expect(await screen.findByText("応答です")).toBeInTheDocument();
    await waitFor(() => expect(headerTitle()).toBe("1通目"));
    expect(plain.renders).toBe(0);
  }, 15000);

  it("付いた名前は、届いたところでサイドバーとヘッダーに出る", async () => {
    const held = gate();
    server.on("/title", async () => {
      await held.promise;
      world.titles[CONV] = "付いた名前";
      return { title: "付いた名前" };
    });
    const user = renderApp();
    await sendFirst(user);
    await arrived();

    // 名付けが返るまでは仮の名前（1通目の本文）
    await waitFor(() => expect(headerTitle()).toBe("1通目"));
    expect(sidebar().getByText("1通目")).toBeInTheDocument();

    held.open();
    expect(await sidebar().findByText("付いた名前")).toBeInTheDocument();
    await waitFor(() => expect(headerTitle()).toBe("付いた名前"));
    expect(sidebar().queryByText("1通目")).toBeNull();
  }, 15000);

  /**
   * 名付けが遷移より先に返ると、一覧はもう新しい名前で取り直されている。
   * 写しの会話はそれより前に読んだ（仮の名前の）もので、画面は「受け取った
   * 時点の一覧から変わっていなければ会話の名前」を出すので、写しのまま
   * 置くと仮の名前へ戻る。
   */
  it("遷移より先に名前が届いても、ヘッダーは仮の名前に戻らない", async () => {
    // 名前が書かれるのは、会話を読んだ後（上流の往復のぶん遅い）
    server.on("/title", async () => {
      await new Promise((r) => setTimeout(r, 20));
      world.titles[CONV] = "付いた名前";
      return { title: "付いた名前" };
    });
    const held = gate();
    server.on("/full", async () => {
      // 名前が書かれる前に読んだもの
      const snapshot = {
        conversation: row(CONV, world.titles[CONV]),
        messages: [...server.messages],
      };
      await held.promise;
      return snapshot;
    });
    const user = renderApp();
    await sendFirst(user);
    await waitFor(() => expect(server.countOf("/full")).toBe(1));

    // 名前が付き、一覧が取り直された（まだホームのまま）
    expect(await sidebar().findByText("付いた名前")).toBeInTheDocument();
    expect(screen.getByTestId("where").textContent).toBe("/");

    held.open();
    await arrived();
    expect(await screen.findByText("応答です")).toBeInTheDocument();
    expect(headerTitle()).toBe("付いた名前");
    // 写しから開いている（引き直して新しい名前を拾ったのではない）
    expect(world.chatFetches).toBe(0);
  }, 15000);

  it("上へ戻って読んでいた位置は、作り直しても変わらない", async () => {
    const held = gate();
    server.on("/full", async () => {
      await held.promise;
      return {
        conversation: row(CONV, world.titles[CONV]),
        messages: [...server.messages],
      };
    });
    const user = renderApp();
    await screen.findByRole("textbox");
    const box = document.querySelector(
      ".absolute.inset-0.overflow-y-auto",
    ) as HTMLElement;
    // 本文が長く、追従が最下部へ合わせる（jsdom の高さは0なので与える）
    Object.defineProperty(box, "scrollHeight", {
      configurable: true,
      get: () => 2000,
    });
    await sendFirst(user);
    expect(await screen.findByText("応答です")).toBeInTheDocument();
    await waitFor(() => expect(server.countOf("/full")).toBe(1));
    // 確定のあと、上へ戻って読み始めた
    expect(box.scrollTop).toBe(2000);
    box.scrollTop = 600;

    held.open();
    await arrived();
    await screen.findByText("応答です");
    const next = document.querySelector(
      ".absolute.inset-0.overflow-y-auto",
    ) as HTMLElement;
    // 作り直された（別の要素）うえで、位置は引き継がれている
    expect(next).not.toBe(box);
    expect(next.scrollTop).toBe(600);
  }, 15000);

  /**
   * 引き継ぎは合わせ直しの1回だけ。残っていると、あとでこの会話を開き
   * 直したとき（再読み込み無しで）に、古い位置へ戻され、素の段も飛ばす。
   */
  it("読み位置の引き継ぎは1度きりで、開き直したときには効かない", async () => {
    const held = gate();
    server.on("/full", async () => {
      await held.promise;
      return {
        conversation: row(CONV, world.titles[CONV]),
        messages: [...server.messages],
      };
    });
    const user = renderApp();
    await screen.findByRole("textbox");
    const box = document.querySelector(
      ".absolute.inset-0.overflow-y-auto",
    ) as HTMLElement;
    Object.defineProperty(box, "scrollHeight", {
      configurable: true,
      get: () => 2000,
    });
    await sendFirst(user);
    await waitFor(() => expect(server.countOf("/full")).toBe(1));
    box.scrollTop = 600;
    held.open();
    await arrived();
    await screen.findByText("応答です");

    // 画面を閉じて、同じ会話をふつうに開き直す
    cleanup();
    plain.renders = 0;
    renderApp(`/chat/${CONV}`);
    expect(await screen.findByText("応答です")).toBeInTheDocument();
    const again = document.querySelector(
      ".absolute.inset-0.overflow-y-auto",
    ) as HTMLElement;
    expect(again.scrollTop).toBe(0);
    // ふつうに開いたときは素の段から始まる（引き継ぎで飛ばしていない）
    expect(plain.renders).toBeGreaterThan(0);
  }, 15000);
});

describe("合わせ直しの歯止め（監査 D-7）", () => {
  /**
   * 自分で別の会話へ移っていたら引き戻さない。新規会話の最初の応答で
   * 「ここから分岐」した直後に元の会話へ戻されるのが、これが無いときの症状。
   * URL は生成開始時に差し替え済みなので、そのままかどうかで見る。
   */
  it("自分で別の場所へ移っていたら、引き戻さない", async () => {
    const held = gate();
    server.on("/full", async () => {
      await held.promise;
      return { error: "まだ" };
    });

    const user = renderApp();
    await sendFirst(user);
    expect(await screen.findByText("応答です")).toBeTruthy();
    await waitFor(() => expect(server.countOf("/full")).toBe(1));

    // 利用者が自分で別の会話へ移った（URL が変わる）
    window.history.replaceState({}, "", "/chat/よその会話");
    held.open();

    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByTestId("where").textContent).toBe("/");
  }, 15000);

  it("会話を読んでいるあいだに2通目を送ったら、遷移しない", async () => {
    const held = gate();
    server.on("/full", async () => {
      await held.promise;
      return { error: "まだ" };
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

    const user = renderApp();
    const box = await screen.findByRole("textbox");
    await sendFirst(user);
    expect(await screen.findByText("応答です")).toBeTruthy();
    await waitFor(() => expect(server.countOf("/full")).toBe(1));

    // 合わせ直しが保留のまま、2通目を送る
    holdGenerate = true;
    await user.type(box, "2通目");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("2通目")).toBeTruthy();

    held.open();

    // 少し待っても遷移していない（＝2通目の画面が生き残っている）
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByTestId("where").textContent).toBe("/");
    expect(screen.getByText("2通目")).toBeTruthy();
  }, 15000);
});
