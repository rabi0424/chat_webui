import { Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { createRoutesStub, useOutletContext } from "react-router";
import Shell, { type ShellContext } from "../../app/routes/shell";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { conv } from "./helpers/sidebar-harness";

/**
 * シェルが、変わっていないもののために画面全体を描き直さないこと。
 *
 * 未読の印は表示中5秒おきに引き直している。以前は中身が同じでも毎回
 * 新しい Set を state に入れていたので、5秒ごとにシェル・サイドバーの
 * 全行（最大200）・開いている会話画面（Outlet の文脈を読む）がそろって
 * 描き直されていた。見た目は何も変わらないので、描いた回数を数えないと
 * 気づけない。
 *
 * 数えるのは2か所。
 *   - サイドバーの会話の行（ConversationItem を数える包みに差し替える）
 *   - Outlet の子（シェルの文脈を読む。会話画面の代わり）
 */
const renders = vi.hoisted(() => ({ rows: 0, child: 0 }));
vi.mock("../../app/components/sidebar/items", async (orig) => {
  const actual =
    await orig<typeof import("../../app/components/sidebar/items")>();
  return {
    ...actual,
    ConversationItem: (
      props: Parameters<typeof actual.ConversationItem>[0],
    ) => {
      renders.rows++;
      return actual.ConversationItem(props);
    },
  };
});

const NARROW_QUERY = "(max-width: 767px)";

/** iPhone の幅かどうかを差し替える（setup.ts の既定は常に false）。 */
function setNarrow(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query === NARROW_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

interface Flags {
  ids: string[];
  generating: string[];
  latest: number;
}

function installFetch(flags: () => Flags): { unreadCalls: () => number } {
  let unreadCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (path.includes("/api/models")) return ok({ models: [] });
    if (path.includes("/api/fx")) return ok({ usdJpy: 150 });
    if (path.includes("/api/conversations/unread")) {
      unreadCalls++;
      return ok(flags());
    }
    return ok({ ok: true });
  }) as typeof fetch;
  return { unreadCalls: () => unreadCalls };
}

const conversations = Array.from({ length: 5 }, (_, i) =>
  conv(`c-${i}`, `会話${i}`),
);
const loaderData = {
  conversations,
  bots: [],
  folders: [],
  settings: DEFAULT_APP_SETTINGS,
  now: 1_700_000_000_000,
};

/** 会話画面の代わり。シェルの文脈を読む。 */
function Child() {
  const { openSidebar } = useOutletContext<ShellContext>();
  return (
    <main data-testid="child">
      <button type="button" onClick={openSidebar}>
        ドロワーを開く
      </button>
    </main>
  );
}

/** 描いた回数は Profiler で数える（文脈が変わって Child だけが描き直されても届く）。 */
function CountedChild() {
  return (
    <Profiler id="child" onRender={() => renders.child++}>
      <Child />
    </Profiler>
  );
}

function ShellRoute() {
  return <Shell {...({ loaderData } as never)} />;
}

const Routes = createRoutesStub([
  {
    path: "/",
    Component: ShellRoute,
    children: [{ index: true, Component: CountedChild }],
  },
]);

function Stub() {
  return <Routes initialEntries={["/"]} />;
}

/** 印の引き直しを1回起こし、その応答が画面側で処理されるまで待つ。 */
async function poll(unreadCalls: () => number) {
  const before = unreadCalls();
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => expect(unreadCalls()).toBe(before + 1));
  // 応答の json() と state の反映まで流す
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

beforeEach(() => {
  localStorage.clear();
  setNarrow(false);
  renders.rows = 0;
  renders.child = 0;
});

describe("未読の引き直し", () => {
  it("中身が変わらなければ、サイドバーの行も会話画面も描き直さない", async () => {
    const { unreadCalls } = installFetch(() => ({
      ids: ["c-1"],
      generating: [],
      latest: 100,
    }));
    render(<Stub />);
    // 初回の取得（null → 値）で印が付くのは正しい描き直し。落ち着くまで待つ
    await waitFor(() =>
      expect(screen.getAllByLabelText("新しい応答があります")).toHaveLength(1),
    );
    await poll(unreadCalls);
    renders.rows = 0;
    renders.child = 0;

    await poll(unreadCalls);
    await poll(unreadCalls);
    await poll(unreadCalls);

    expect(renders.rows).toBe(0);
    expect(renders.child).toBe(0);
    // 行が消えたから 0 なのではないこと
    expect(screen.getByText("会話4")).toBeInTheDocument();
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.getAllByLabelText("新しい応答があります")).toHaveLength(1);
  });

  it("変わったときは描き直して、印を付け替える", async () => {
    let flags: Flags = { ids: [], generating: [], latest: 100 };
    const { unreadCalls } = installFetch(() => flags);
    render(<Stub />);
    await poll(unreadCalls);
    expect(screen.queryByLabelText("新しい応答があります")).toBeNull();
    renders.rows = 0;

    flags = { ids: ["c-2"], generating: [], latest: 100 };
    await poll(unreadCalls);
    expect(renders.rows).toBeGreaterThan(0);
    const dot = screen.getByLabelText("新しい応答があります");
    expect(dot.closest("a")?.textContent).toContain("会話2");

    // 減ったとき（別の端末で開いて既読になった）も同じではない。
    // 「手元に無いものが来たか」だけを見ると、減ったことを見落とす
    flags = { ids: [], generating: [], latest: 100 };
    await poll(unreadCalls);
    expect(screen.queryByLabelText("新しい応答があります")).toBeNull();
    expect(screen.getByText("会話2")).toBeInTheDocument();

    // 生成中の集合だけが変わっても、描き直して光らせる
    renders.rows = 0;
    flags = { ids: [], generating: ["c-3"], latest: 100 };
    await poll(unreadCalls);
    expect(renders.rows).toBeGreaterThan(0);
    expect(screen.getByText("（生成中）").closest("a")?.textContent).toContain(
      "会話3",
    );
  });
});

describe("シェルだけの描き直し", () => {
  /**
   * 印の引き直し以外にも、シェルは自分の都合で描き直す（ショートカットの
   * 一覧を開く・遷移の開始と終了など）。そのたびにサイドバーの全行と
   * 会話画面まで付き合わせない。
   */
  it("ショートカットの一覧を開いても、サイドバーと会話画面は描き直さない", async () => {
    const { unreadCalls } = installFetch(() => ({
      ids: [],
      generating: [],
      latest: 100,
    }));
    render(<Stub />);
    await poll(unreadCalls);
    renders.rows = 0;
    renders.child = 0;

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true }),
      );
    });
    // シェルは確かに描き直した（一覧が出ている）
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    expect(renders.rows).toBe(0);
    expect(renders.child).toBe(0);
    expect(screen.getByText("会話0")).toBeInTheDocument();
  });
});

describe("iPhone の幅", () => {
  it("見えないデスクトップ用のサイドバーは描かず、ドロワーでは出る", async () => {
    setNarrow(true);
    const { unreadCalls } = installFetch(() => ({
      ids: [],
      generating: [],
      latest: 100,
    }));
    render(<Stub />);
    await poll(unreadCalls);

    // 本文は出ている隣で、一覧の行は1つも描かれていない
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.queryByText("会話0")).toBeNull();
    expect(renders.rows).toBe(0);

    // ドロワーを開けば一覧は出る（サイドバーそのものは壊れていない）
    await act(async () => {
      screen.getByRole("button", { name: "ドロワーを開く" }).click();
    });
    expect(await screen.findByText("会話0")).toBeInTheDocument();
    // デスクトップ用とドロワーの2つではなく、ドロワーの1つだけ
    expect(screen.getAllByText("会話0")).toHaveLength(1);

    // 開いたドロワーも、シェルだけの描き直しには付き合わない
    // （ドロワーへ渡す「閉じる」が描画のたびに新しいと、ここで全行が描き直される）
    renders.rows = 0;
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true }),
      );
    });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(renders.rows).toBe(0);
    expect(screen.getByText("会話0")).toBeInTheDocument();
  });

  it("デスクトップの幅では常設のサイドバーを描く", async () => {
    const { unreadCalls } = installFetch(() => ({
      ids: [],
      generating: [],
      latest: 100,
    }));
    render(<Stub />);
    await poll(unreadCalls);
    expect(screen.getByText("会話0")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "サイドバーを畳む" }),
    ).toBeInTheDocument();
  });

  /**
   * サーバーは幅を知らないので、常設のサイドバーを描いて返す（CSS で
   * 隠れる）。iPhone でそれを受け取ってハイドレーションしても食い違いに
   * ならず、そのあとで外れること。食い違うと React は描き直しに落ち、
   * <html> に載せた見た目まで消える。
   */
  it("サーバーの出力を iPhone でハイドレーションしても食い違わず、そのあと外れる", async () => {
    installFetch(() => ({ ids: [], generating: [], latest: 100 }));
    const html = renderToString(<Stub />);
    // サーバーは常設のサイドバーを描いている（隠すのは CSS）
    expect(html).toContain("会話0");

    setNarrow(true);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(container, <Stub />, {
        onRecoverableError: (e) => errors.push(e),
      });
    });
    await waitFor(() =>
      expect(within(container).queryByText("会話0")).toBeNull(),
    );
    expect(within(container).getByTestId("child")).toBeInTheDocument();
    expect(errors).toEqual([]);
    act(() => root!.unmount());
    container.remove();
  });
});
