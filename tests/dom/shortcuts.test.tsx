import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import Shell from "../../app/routes/shell";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { useShortcut } from "../../app/lib/use-shortcut";

/**
 * キーボードショートカット（UI-11）の配線。
 *
 * 表と判定は tests/shortcuts.test.ts。こちらは「押したら画面が動くか」
 * ——拾う所（shell）と動く所（サイドバー・ルーター）が繋がっていないと、
 * 表があっても何も起きない。
 */
beforeEach(() => {
  localStorage.clear();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ids: [], generating: [], latest: 0, models: [], usdJpy: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
});

const conv = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `会話 ${id}`,
  model_id: "openai/gpt-4o-mini",
  pinned: 0,
  sort_order: 0,
  created_at: 1,
  updated_at: 1,
  folder_id: null,
  favorite: 0,
  unread: 0,
  current_leaf_message_id: null,
  ...extra,
});

function Probe() {
  const loc = useLocation();
  return <p data-testid="path">{loc.pathname}</p>;
}

async function renderShell(initialPath = "/") {
  const loaderData = {
    conversations: [conv("c1"), conv("c2"), conv("c3")],
    bots: [],
    folders: [],
    settings: DEFAULT_APP_SETTINGS,
    now: Date.now(),
  };
  const Stub = createRoutesStub([
    {
      path: "/",
      loader: () => loaderData,
      Component: () => <Shell {...({ loaderData } as never)} />,
      children: [
        { index: true, Component: () => <div><Probe /><textarea aria-label="メッセージ" /></div> },
        { path: "chat/:id", Component: Probe },
      ],
    },
  ]);
  render(<Stub initialEntries={[initialPath]} />);
  // ルーターのスタブはローダーを待ってから描く。描かれる前に押しても
  // 拾う相手が居ない
  await screen.findByTestId("path");
  return userEvent.setup();
}

const path = () => screen.getByTestId("path").textContent;
const press = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
  // 前のテストで外れた要素にフォーカスが残っていることがあるので、常に body へ
  fireEvent.keyDown(document.body, { key, metaKey: true, ...mods });

describe("サイドバーを畳む（⌘\\）", () => {
  it("畳むとサイドバーが外れ、開くボタンが出る。もう一度で戻る", async () => {
    await renderShell();
    expect(screen.getByRole("button", { name: "サイドバーを畳む" })).toBeTruthy();
    press("\\");
    // 最初のテストは描画の準備（変換）込みで遅いことがある
    await waitFor(
      () => expect(screen.queryByRole("button", { name: "サイドバーを畳む" })).toBeNull(),
      { timeout: 4000 },
    );
    expect(screen.getByRole("button", { name: "サイドバーを開く" })).toBeTruthy();
    // 保存されている（次に開いたときも畳まれたまま）
    expect(localStorage.getItem("chat-webui:sidebar-collapsed")).toBe("1");
    press("\\");
    await waitFor(() => expect(screen.getByRole("button", { name: "サイドバーを畳む" })).toBeTruthy());
    expect(localStorage.getItem("chat-webui:sidebar-collapsed")).toBeNull();
  });

  it("ボタンでも畳める・開ける", async () => {
    const user = await renderShell();
    await user.click(screen.getByRole("button", { name: "サイドバーを畳む" }));
    await user.click(await screen.findByRole("button", { name: "サイドバーを開く" }));
    expect(await screen.findByRole("button", { name: "サイドバーを畳む" })).toBeTruthy();
  });
});

describe("会話を辿る（⌘↑ / ⌘↓）", () => {
  it("次へ・前へ。端では止まる", async () => {
    await renderShell("/chat/c1");
    press("ArrowDown");
    await waitFor(() => expect(path()).toBe("/chat/c2"));
    press("ArrowDown");
    await waitFor(() => expect(path()).toBe("/chat/c3"));
    press("ArrowDown");
    await new Promise((r) => setTimeout(r, 20));
    expect(path()).toBe("/chat/c3");
    press("ArrowUp");
    await waitFor(() => expect(path()).toBe("/chat/c2"));
  });

  it("入力欄の中では奪わない（行頭・行末へ動かすキーなので）", async () => {
    await renderShell("/");
    const ta = screen.getByRole("textbox", { name: "メッセージ" });
    ta.focus();
    fireEvent.keyDown(ta, { key: "ArrowDown", metaKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(path()).toBe("/");
  });

  it("会話を開いていなければ ↓ で先頭へ", async () => {
    await renderShell("/");
    press("ArrowDown");
    await waitFor(() => expect(path()).toBe("/chat/c1"));
  });
});

describe("そのほか", () => {
  it("⌘N でホームへ", async () => {
    await renderShell("/chat/c2");
    press("n");
    await waitFor(() => expect(path()).toBe("/"));
  });

  it("⌘/ で一覧が開き、Escape で閉じる", async () => {
    await renderShell();
    press("/");
    const dialog = await screen.findByRole("dialog", { name: "キーボードショートカット" });
    expect(dialog.textContent).toContain("新規チャット");
    // 表記は端末しだい（jsdom は Mac ではない）
    expect(dialog.textContent).toMatch(/⌘⇧M|Ctrl\+Shift\+M/);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "キーボードショートカット" })).toBeNull(),
    );
  });

  it("⌘K で検索欄が開いてフォーカスされる", async () => {
    await renderShell();
    press("k");
    const input = await screen.findByRole("textbox", { name: "会話を検索" });
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("⌘⇧C は部品へ配られ、⌘C（⇧無し）は配られない", async () => {
    const handler = vi.fn();
    function Receiver() {
      useShortcut("copy-last", handler);
      return <p data-testid="path">ready</p>;
    }
    const loaderData = { conversations: [], bots: [], folders: [], settings: DEFAULT_APP_SETTINGS, now: 0 };
    const Stub = createRoutesStub([
      {
        path: "/",
        loader: () => loaderData,
        Component: () => <Shell {...({ loaderData } as never)} />,
        children: [{ index: true, Component: Receiver }],
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
    await screen.findByTestId("path");
    fireEvent.keyDown(document.body, { key: "c", metaKey: true });
    expect(handler).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "C", metaKey: true, shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
