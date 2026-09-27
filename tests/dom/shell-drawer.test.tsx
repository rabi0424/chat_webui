import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { createRoutesStub, useOutletContext } from "react-router";
import Shell, { type ShellContext } from "../../app/routes/shell";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { conv } from "./helpers/sidebar-harness";

/**
 * iPhone のドロワーを開くたびに一覧を作り直さない。
 *
 * 以前は閉じるたびに外し、開くたびに作り直していた。しかも作り直しの
 * たびに「サーバーと揃えるための20行」から始めていたので、開くスライド
 * （0.24秒）とぼかしの最中に「20行→全行」の2度描きが走っていた。
 * 画面には何も出ないので、行を描いた回数と作った回数を数える。
 */
const counts = vi.hoisted(() => ({ renders: 0, mounts: 0 }));
vi.mock("../../app/components/sidebar/items", async (orig) => {
  const actual =
    await orig<typeof import("../../app/components/sidebar/items")>();
  const { useEffect } = await import("react");
  return {
    ...actual,
    ConversationItem: (
      props: Parameters<typeof actual.ConversationItem>[0],
    ) => {
      counts.renders++;
      useEffect(() => {
        counts.mounts++;
      }, []);
      return actual.ConversationItem(props);
    },
  };
});

const NARROW_QUERY = "(max-width: 767px)";
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

/** サーバーが描く行数（20）より多くしておく。2度描きはこの差で見える。 */
const ROWS = 30;
const loaderData = {
  conversations: Array.from({ length: ROWS }, (_, i) =>
    conv(`c-${i}`, `会話${i}`),
  ),
  bots: [],
  folders: [],
  settings: DEFAULT_APP_SETTINGS,
  now: 1_700_000_000_000,
};

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

const Routes = createRoutesStub([
  {
    path: "/",
    Component: () => <Shell {...({ loaderData } as never)} />,
    children: [{ index: true, Component: Child }],
  },
]);
const Stub = () => <Routes initialEntries={["/"]} />;

beforeEach(() => {
  localStorage.clear();
  counts.renders = 0;
  counts.mounts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    const body = path.includes("/api/conversations/unread")
      ? { ids: [], generating: [], latest: 1 }
      : path.includes("/api/models")
        ? { models: [] }
        : { ok: true };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

/**
 * 本物と同じ始まり方にする。サーバーは広い画面として常設のサイドバーを
 * 描き、iPhone でハイドレーションしてから外す。
 */
async function hydrateOnPhone() {
  setNarrow(false);
  const html = renderToString(<Stub />);
  setNarrow(true);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  let root: ReturnType<typeof hydrateRoot> | null = null;
  await act(async () => {
    root = hydrateRoot(container, <Stub />);
  });
  await waitFor(() =>
    expect(within(container).queryByText("会話0")).toBeNull(),
  );
  return {
    container,
    unmount: () => {
      act(() => root!.unmount());
      container.remove();
    },
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

describe("ドロワー", () => {
  it("開き直しても行を作り直さず、閉じているあいだは触れない", async () => {
    const { container, unmount } = await hydrateOnPhone();
    const q = within(container);
    await settle();
    counts.renders = 0;
    counts.mounts = 0;

    // 初めて開く。20行から始めず、一度で全行を描く
    await act(async () => {
      q.getByRole("button", { name: "ドロワーを開く" }).click();
    });
    await settle();
    expect(q.getByText(`会話${ROWS - 1}`)).toBeInTheDocument();
    expect(counts.mounts).toBe(ROWS);
    expect(counts.renders).toBe(ROWS);

    const drawer = q.getByTestId("drawer");
    expect(drawer.hasAttribute("inert")).toBe(false);

    // 閉じる（Escape → 退場の動きが終わる）
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    const panel = drawer.children[1] as HTMLElement;
    expect(panel.className).toContain("animate-drawer-out");
    // jsdom は animationend を React へ届けない（React は接頭辞付きの名前を
    // 待つ）ので、動きが来ないときの保険（700ms）で閉じ切るのを待つ
    await act(async () => {
      await new Promise((r) => setTimeout(r, 750));
    });

    // 外さずに残す。ただし見えず・押せず・フォーカスも入らない
    expect(q.getByTestId("drawer")).toBe(drawer);
    expect(drawer.getAttribute("data-open")).toBe("false");
    expect(drawer.hasAttribute("inert")).toBe(true);
    expect(drawer.className).toContain("invisible");
    // 本文は見えている（シェルごと落ちたのではない）
    expect(q.getByTestId("child")).toBeInTheDocument();

    // 開き直す。行は1つも作り直さず、描き直しもしない
    counts.renders = 0;
    counts.mounts = 0;
    await act(async () => {
      q.getByRole("button", { name: "ドロワーを開く" }).click();
    });
    await settle();
    expect(counts.mounts).toBe(0);
    expect(counts.renders).toBe(0);
    expect(drawer.getAttribute("data-open")).toBe("true");
    expect(drawer.hasAttribute("inert")).toBe(false);
    expect(drawer.className).not.toContain("invisible");
    expect(panel.className).toContain("animate-drawer");
    expect(panel.className).not.toContain("animate-drawer-out");
    expect(q.getByText("会話0")).toBeVisible();

    // Escape はまた効く
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(panel.className).toContain("animate-drawer-out");
    unmount();
  });
});
