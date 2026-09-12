import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, createRoutesStub } from "react-router";
import Shell from "../../app/routes/shell";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { FLUSH_THRESHOLD, currentBuildId, loadSamples } from "../../app/lib/perf";

/**
 * 控えを送りに行く配線（shell.tsx → lib/perf.ts → /api/perf）。
 *
 * 記録そのものは localStorage に貯まるだけなので、送る側が外れても
 * **画面には何も起きない**。設定画面を開いた人だけが「なぜか古い数字
 * しか無い」と気づく——それも、その端末で開いたときだけ。
 *
 * 送り時は2つ。画面が隠れる／閉じるときと、溜まりすぎたとき。
 * iPhone では閉じたときに visibilitychange が来るとは限らないので
 * pagehide も拾う（片方だけだと、その端末のぶんが溜まったままになる）。
 */
const posted: { url: string; samples: { path: string }[] }[] = [];

function seed(count: number): void {
  localStorage.setItem(
    "chat-webui:perf",
    JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
        id: `s${i}`,
        t: Date.now(),
        path: "/images",
        ms: 10 + i,
        build: currentBuildId(),
        deviceId: "d1",
        device: "Mac",
        browser: "Safari 18",
        mode: "browser",
      })),
    ),
  );
}

function renderShell() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/perf") && init?.method === "POST") {
      posted.push({
        url,
        samples: (JSON.parse(String(init.body)) as { samples: { path: string }[] })
          .samples,
      });
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }
    const body = url.includes("/api/models")
      ? { models: [] }
      : url.includes("/api/fx")
        ? { usdJpy: 150 }
        : { ids: [], generating: [], latest: 0 };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const loaderData = {
    conversations: [],
    bots: [],
    folders: [],
    settings: DEFAULT_APP_SETTINGS,
    now: 1_700_000_000_000,
  };
  const Stub = createRoutesStub([
    {
      path: "/",
      loader: () => loaderData,
      Component: () => <Shell {...({ loaderData } as never)} />,
      children: [
        { index: true, Component: () => <Link to="/images">遷移のきっかけ</Link> },
        {
          path: "images",
          // 遷移が一瞬で終わると useNavigation が idle を離れず、
          // 所要時間を測る道そのものが通らない
          loader: async () => {
            await new Promise((r) => setTimeout(r, 5));
            return null;
          },
          Component: () => <p>遷移先の中身</p>,
        },
      ],
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

beforeEach(() => {
  localStorage.clear();
  posted.length = 0;
});

/**
 * 控えが落ち着くまで待って、件数を返す。
 *
 * 起動の記録は「文書ごとに1回」なので、同じファイルの2つ目以降の
 * render には付かない（本番では文書が読み込まれるたびに新しくなる）。
 * 件数を決め打ちにすると、その事情でテストが折れる。
 */
async function settledCount(min: number): Promise<number> {
  // 聞き耳（visibilitychange / pagehide）を立てるのはマウント後の効果な
  // ので、画面が出るのを待ってから数える
  await screen.findByText("遷移のきっかけ");
  await waitFor(() => expect(loadSamples().length).toBeGreaterThanOrEqual(min));
  return loadSamples().length;
}

describe("控えの送り時", () => {
  it("画面が隠れたら送る", async () => {
    seed(3);
    renderShell();
    const pending = await settledCount(3);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(posted.length).toBe(1));
    // 溜まっていた分が全部乗っていること（一部だけ送って残りを消す形に
    // なっていないか）
    expect(posted[0].samples).toHaveLength(pending);
    expect(loadSamples()).toEqual([]);
  });

  /** iPhone で閉じたときは、こちらしか来ないことがある。 */
  it("画面を閉じるときも送る", async () => {
    seed(1);
    renderShell();
    const pending = await settledCount(1);

    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].samples).toHaveLength(pending);
    expect(loadSamples()).toEqual([]);
  });

  /** 隠れただけ（タブを離れた）では、まだ閉じていないので記録は続く。 */
  it("見えているあいだは送らない", async () => {
    seed(2);
    renderShell();
    await settledCount(2);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await new Promise((r) => setTimeout(r, 30));
    expect(posted).toEqual([]);
    expect(loadSamples().length).toBeGreaterThanOrEqual(2);
  });

  /**
   * 隠れるのを待たずに送る道も要る。ブラウザを閉じずに何日も使うと、
   * 控えの上限（1000件）に当たって古いものから捨てられる。
   */
  it("溜まりすぎたら、隠れるのを待たずに送る", async () => {
    // あと1件で上限に届く状態にしておく
    seed(FLUSH_THRESHOLD - 1);
    const user = renderShell();
    await settledCount(FLUSH_THRESHOLD - 1);
    expect(posted).toEqual([]);

    await user.click(await screen.findByText("遷移のきっかけ"));
    await screen.findByText("遷移先の中身");

    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0].samples.length).toBeGreaterThanOrEqual(FLUSH_THRESHOLD);
    expect(loadSamples()).toEqual([]);
  });

  /** 上限に届いていないうちは送らない（遷移のたびに往復させない）。 */
  it("上限に届かない遷移では送らない", async () => {
    const user = renderShell();
    const before = await settledCount(0);

    await user.click(await screen.findByText("遷移のきっかけ"));
    await screen.findByText("遷移先の中身");

    // 遷移そのものは記録されている（記録が止まっていないこと）
    await waitFor(() => expect(loadSamples().length).toBe(before + 1));
    expect(posted).toEqual([]);
  });
});
