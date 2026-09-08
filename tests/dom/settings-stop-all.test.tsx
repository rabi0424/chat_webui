import { beforeEach, describe, expect, it } from "vitest";
import { createRoutesStub, Outlet } from "react-router";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Settings from "../../app/routes/settings";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../../app/lib/settings";
import { TEST_MODEL } from "./helpers/chat-harness";

/**
 * 実行体の時間を守るための2つの手立て。
 *
 * Cloudflare の無料枠（1日 約104,000秒）を使い切ると**どの生成も
 * 始められなくなり、翌0時（UTC）まで戻らない**。実際に2日続けて
 * 締め出された。歯止めの秒数を変えられること、そして溜まった実行が
 * 一斉に動き出したときに**止める手段が画面にあること**を見張る。
 * ボタンが押せても要求がどこへも飛ばなければ、締め出しは止まらない。
 */
const calls: { url: string; method: string; body: unknown }[] = [];

function renderSettings(settings: Partial<AppSettings> = {}) {
  const merged = { ...DEFAULT_APP_SETTINGS, ...settings };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const payload = url.includes("stop-all")
      ? { stopped: 3 }
      : { settings: { ...merged, ...(init?.body ? JSON.parse(String(init.body)) : {}) } };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const shell = {
    models: [TEST_MODEL],
    bots: [],
    usdJpy: 150,
    settings: merged,
    openSidebar: () => {},
  };
  const loaderData = { settings: merged, now: 1_700_000_000_000 };
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
          Component: () => <Settings {...({ loaderData } as never)} />,
        },
      ],
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
});

describe("走っている生成をすべて止める", () => {
  it("押すと止める要求が飛び、止めた本数が出る", async () => {
    const user = renderSettings();
    await user.click(screen.getByRole("button", { name: "すべて止める" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /3件に止まるよう伝えました/ })).toBeTruthy(),
    );
    const stop = calls.filter((c) => c.url.includes("stop-all"));
    expect(stop).toHaveLength(1);
    expect(stop[0].url).toBe("/api/generations/stop-all");
    expect(stop[0].method).toBe("POST");
  });

  it("失敗したらそう出す（押したのに何も起きないと分からない）", async () => {
    const user = renderSettings();
    globalThis.fetch = (async () =>
      new Response("no", { status: 500 })) as typeof fetch;
    await user.click(screen.getByRole("button", { name: "すべて止める" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "止められませんでした" })).toBeTruthy(),
    );
  });
});

describe("実行体の時間の設定", () => {
  const spin = (name: string) =>
    screen.getByRole("spinbutton", { name }) as HTMLInputElement;

  it("1日の上限を変えると保存へ飛ぶ", async () => {
    const user = renderSettings({ dailyDoSecondsBudget: 90_000 });
    expect(spin("1日の実行体の時間").value).toBe("90000");
    await user.clear(spin("1日の実行体の時間"));
    await user.type(spin("1日の実行体の時間"), "50000");
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === "/api/settings" &&
            (c.body as { dailyDoSecondsBudget?: number })
              ?.dailyDoSecondsBudget === 50_000,
        ),
      ).toBe(true),
    );
  });

  it("担当1つの同時数を変えると保存へ飛ぶ", async () => {
    const user = renderSettings({ retryWorkerConcurrency: 0 });
    expect(spin("担当1つの同時数").value).toBe("0");
    await user.clear(spin("担当1つの同時数"));
    await user.type(spin("担当1つの同時数"), "12");
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === "/api/settings" &&
            (c.body as { retryWorkerConcurrency?: number })
              ?.retryWorkerConcurrency === 12,
        ),
      ).toBe(true),
    );
  });
});
