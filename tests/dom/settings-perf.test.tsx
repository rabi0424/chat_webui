import { beforeEach, describe, expect, it } from "vitest";
import { createRoutesStub, Outlet } from "react-router";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Settings from "../../app/routes/settings";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { TEST_MODEL } from "./helpers/chat-harness";
import { currentBuildId } from "../../app/lib/perf";

/**
 * 設定画面の「開発者向け: 起動とページ遷移の計測」。
 *
 * 見張るのは2つ。
 *
 * 1. **畳んでいるあいだは集計を引かない。**`<details>` の中身は閉じて
 *    いても DOM に居るので、素直に置くと設定画面を開くたびに D1 を読む
 *    （読んだ行数で課金される）。画面には何も出ないので、気づく手立てが
 *    テストしかない。
 * 2. 開いたら、まず控えを送ってから集計を引く。順が逆だと、いま測った
 *    ぶんが表に出ず「記録されていない」ように見える。
 */
const calls: { url: string; method: string }[] = [];
/** 送信と取得の**前後関係**を見るための足跡（呼んだ順ではなく、終わった順）。 */
const order: string[] = [];

const HISTORY = {
  dimension: "path",
  path: null,
  paths: ["(起動)", "/chat/:id"],
  builds: [
    { build: currentBuildId(), firstAt: 1_700_000_000_000, lastAt: 1_700_000_100_000 },
    { build: "older01", firstAt: 1_600_000_000_000, lastAt: 1_600_000_100_000 },
  ],
  groups: [
    {
      build: currentBuildId(),
      key: "(起動)",
      label: "(起動)",
      count: 12,
      median: 420,
      p90: 900,
      slowest: 1200,
      firstAt: 1_700_000_000_000,
      lastAt: 1_700_000_100_000,
    },
    {
      build: "older01",
      key: "(起動)",
      label: "(起動)",
      count: 30,
      median: 700,
      p90: 1500,
      slowest: 2000,
      firstAt: 1_600_000_000_000,
      lastAt: 1_600_000_100_000,
    },
  ],
};

function renderSettings() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const perf = url.startsWith("/api/perf");
    if (perf && method === "POST") {
      order.push("送信の開始");
      // 送信には時間がかかる。並べて投げていれば、この待ちのあいだに
      // 取得が走ってしまう
      await new Promise((r) => setTimeout(r, 20));
      order.push("送信の完了");
    }
    if (perf && method === "GET") order.push("取得");
    const payload = perf
      ? method === "POST"
        ? { accepted: 1 }
        : HISTORY
      : { settings: DEFAULT_APP_SETTINGS };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const shell = {
    models: [TEST_MODEL],
    bots: [],
    usdJpy: 150,
    settings: DEFAULT_APP_SETTINGS,
    openSidebar: () => {},
  };
  const loaderData = { settings: DEFAULT_APP_SETTINGS, now: 1_700_000_000_000 };
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ConfirmProvider>
          <Outlet context={shell} />
        </ConfirmProvider>
      ),
      children: [
        { index: true, Component: () => <Settings {...({ loaderData } as never)} /> },
      ],
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

const perfCalls = () => calls.filter((c) => c.url.startsWith("/api/perf"));

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
  order.length = 0;
});

describe("開発者向けの計測", () => {
  it("畳んでいるあいだは、集計を引かない", async () => {
    renderSettings();
    // 畳まれた隣で、見出し自体は見えていること（部品が落ちていれば
    // 「引いていない」も同じように成り立ってしまう）
    expect(
      await screen.findByText(/開発者向け: 起動とページ遷移の計測/),
    ).toBeInTheDocument();
    expect(screen.queryByText("端末別")).not.toBeInTheDocument();
    expect(perfCalls()).toEqual([]);
  });

  it("開くと、控えを送ってから履歴を引く", async () => {
    // この端末で未送信の記録がある状態にする
    localStorage.setItem(
      "chat-webui:perf",
      JSON.stringify([
        {
          id: "s1",
          t: Date.now(),
          path: "(起動)",
          ms: 400,
          build: currentBuildId(),
          deviceId: "d1",
          device: "Mac",
          browser: "Safari 18",
          mode: "browser",
        },
      ]),
    );
    const user = renderSettings();
    await user.click(await screen.findByText(/開発者向け: 起動とページ遷移の計測/));

    await waitFor(() => expect(perfCalls().length).toBe(2));
    // 送り終えてから引く。逆だと、いま測ったぶんが表に出ない
    expect(order).toEqual(["送信の開始", "送信の完了", "取得"]);
    expect(perfCalls()[1].url).toContain("dimension=path");
    // 送れたぶんは控えから消えている
    expect(JSON.parse(localStorage.getItem("chat-webui:perf")!)).toEqual([]);
  });

  it("ビルドごとの数字と、前のビルドとの差が出る", async () => {
    const user = renderSettings();
    await user.click(await screen.findByText(/開発者向け: 起動とページ遷移の計測/));

    expect(await screen.findByText("420ms")).toBeInTheDocument();
    expect(screen.getByText("700ms")).toBeInTheDocument();
    // 420 は 700 から 280ms（-40%）速くなっている
    expect(screen.getByText("-280ms / -40%")).toBeInTheDocument();
    // どちらのビルドの行も出る（過去の版を辿れること）
    expect(screen.getByText(currentBuildId())).toBeInTheDocument();
    expect(screen.getByText("older01")).toBeInTheDocument();
    expect(screen.getByText("現行")).toBeInTheDocument();
  });

  /**
   * 起動（数秒）と画面遷移（数十ミリ秒）を混ぜたまま端末別に見ると、
   * 中央値も p90 も「どちらの話か分からない数字」になる。ページを
   * 絞れることが、端末別・ブラウザ別の数字が意味を持つ前提。
   */
  it("ページを絞ると、その条件で引き直す", async () => {
    const user = renderSettings();
    await user.click(await screen.findByText(/開発者向け: 起動とページ遷移の計測/));
    await waitFor(() => expect(perfCalls().length).toBe(1));

    await user.click(screen.getByRole("button", { name: "(起動)" }));
    await waitFor(() =>
      expect(
        perfCalls().some((c) => c.url.includes(`path=${encodeURIComponent("(起動)")}`)),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "(起動)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // 絞りを外すと、ページの条件は付かない
    await user.click(screen.getByRole("button", { name: "すべてのページ" }));
    await waitFor(() => expect(perfCalls().length).toBe(3));
    expect(perfCalls()[2].url).not.toContain("path=");
  });

  it("内訳を変えると、その切り口で引き直す", async () => {
    const user = renderSettings();
    await user.click(await screen.findByText(/開発者向け: 起動とページ遷移の計測/));
    await waitFor(() => expect(perfCalls().length).toBe(1));

    await user.click(screen.getByRole("button", { name: "端末別" }));
    await waitFor(() =>
      expect(perfCalls().some((c) => c.url.includes("dimension=device"))).toBe(true),
    );
    // 押した内訳が選ばれたまま（押すたびに既定へ戻らないこと）
    expect(screen.getByRole("button", { name: "端末別" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
