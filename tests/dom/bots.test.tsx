import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { createRoutesStub, Outlet, useLocation, useParams } from "react-router";
import userEvent from "@testing-library/user-event";
import Bots from "../../app/routes/bots";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";

/**
 * ボット一覧（UI-9）。
 *
 * 行そのものを押すと編集へ。複製と削除は「…」の中に畳み、削除は
 * アプリ内の確認を挟む（ブラウザの confirm() は使わない）。
 */
let calls: { method: string; path: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    let body: unknown = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ method: init?.method ?? "GET", path, body });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

const bot = (id: string, name: string) => ({
  id,
  name,
  icon: "🤖",
  model_id: "openai/gpt-4o",
  system_prompt: "です・ます調で",
  params_json: null,
  created_at: 1,
  updated_at: 1,
});

function Probe() {
  const loc = useLocation();
  const params = useParams();
  return <p data-testid="path">{loc.pathname} {params.id ?? ""}</p>;
}

function renderBots(bots = [bot("b1", "翻訳者"), bot("b2", "校正")]) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ConfirmProvider>
          <Outlet
            context={{
              bots,
              models: [{ id: "openai/gpt-4o", name: "OpenAI: GPT-4o" }],
              openSidebar: () => {},
            }}
          />
        </ConfirmProvider>
      ),
      children: [
        { path: "bots", Component: Bots },
        { path: "bots/new", Component: Probe },
        { path: "bots/:id/edit", Component: Probe },
      ],
    },
  ]);
  render(<Stub initialEntries={["/bots"]} />);
  return userEvent.setup();
}

describe("ボット一覧", () => {
  it("行を押すと編集へ", async () => {
    const user = renderBots();
    await user.click(screen.getByRole("link", { name: /翻訳者/ }));
    expect(screen.getByTestId("path").textContent).toBe("/bots/b1/edit b1");
  });

  it("行にはモデルの名前が添えてあり、文字のボタンは並んでいない", () => {
    renderBots();
    expect(screen.getAllByText("OpenAI: GPT-4o")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "編集" })).toBeNull();
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
  });

  it("「…」から複製すると、同じ設定で「のコピー」を作る", async () => {
    const user = renderBots();
    await user.click(screen.getByRole("button", { name: "翻訳者 のメニュー" }));
    await user.click(screen.getByRole("menuitem", { name: "複製" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/bots");
    expect(post.body).toMatchObject({
      name: "翻訳者のコピー",
      modelId: "openai/gpt-4o",
      systemPrompt: "です・ます調で",
    });
    // メニューは閉じる
    expect(screen.queryByRole("menuitem", { name: "複製" })).toBeNull();
  });

  it("削除は確認を挟み、取りやめなら送らない", async () => {
    const user = renderBots();
    await user.click(screen.getByRole("button", { name: "校正 のメニュー" }));
    await user.click(screen.getByRole("menuitem", { name: "削除" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/校正/)).toBeTruthy();
    await user.click(screen.getByTestId("dialog-cancel"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: "校正 のメニュー" }));
    await user.click(screen.getByRole("menuitem", { name: "削除" }));
    await user.click(await screen.findByTestId("dialog-confirm"));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "DELETE")?.path).toBe("/api/bots/b2"),
    );
  });

  it("1つも無ければ、作る入口を出す", async () => {
    const user = renderBots([]);
    expect(screen.getByText("ボットはまだありません")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: /ボットを作る/ }));
    expect(screen.getByTestId("path").textContent).toBe("/bots/new ");
  });
});
