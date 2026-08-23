import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import Shell from "../../app/routes/shell";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { readCachedModels, writeCachedModels } from "../../app/lib/model-cache";

/**
 * 裏の取得が失敗したときの見え方（監査 C-2）。
 *
 * 純粋な部分（投げ直しと文言）は tests/shell-load.test.ts で見ている。
 * こちらは「画面まで届いているか」——理由を作るところと出すところが
 * 繋がっていないと、握りつぶしていたのと同じことになる。
 */
const MODEL = {
  id: "openai/gpt-4o-mini",
  name: "GPT-4o mini",
  contextLength: 128000,
  promptPrice: "0.0000001",
  completionPrice: "0.0000002",
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: [],
  provider: "openrouter",
};

/** 応答を決める。models と fx を別々に指せる。 */
function installFetch(plan: {
  models?: () => Response | Promise<Response> | never;
  fx?: () => Response | Promise<Response>;
  /** サイドバーの印（未読・生成中・一覧が動いた時刻）。 */
  unread?: () => unknown;
}): { modelCalls: () => number; unreadCalls: () => number } {
  let modelCalls = 0;
  let unreadCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (path.includes("/api/models")) {
      modelCalls++;
      return plan.models ? plan.models() : ok({ models: [MODEL] });
    }
    if (path.includes("/api/fx")) return plan.fx ? plan.fx() : ok({ usdJpy: 150 });
    if (path.includes("/api/conversations/unread")) {
      unreadCalls++;
      return ok(
        plan.unread ? plan.unread() : { ids: [], generating: [], latest: 0 },
      );
    }
    return ok({ ids: [] });
  }) as typeof fetch;
  return { modelCalls: () => modelCalls, unreadCalls: () => unreadCalls };
}

function renderShell(options: { onLoad?: () => void } = {}) {
  const loaderData = {
    conversations: [],
    bots: [],
    folders: [],
    settings: DEFAULT_APP_SETTINGS,
  };
  const Stub = createRoutesStub([
    {
      path: "/",
      // 型は本物のルートのものだが、テストで要るのは loaderData だけ
      loader: () => {
        options.onLoad?.();
        return loaderData;
      },
      Component: () => <Shell {...({ loaderData } as never)} />,
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe("裏の取得が失敗したとき", () => {
  it("理由が画面に出る", async () => {
    installFetch({
      models: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderShell();

    const notice = await screen.findByRole("status", {}, { timeout: 8000 });
    expect(notice.textContent).toContain("モデル一覧を取得できませんでした");
    expect(notice.textContent).toContain("つながりませんでした");
    // 手元に一覧が無いので、送れないことまで出る
    expect(notice.textContent).toContain("送信もできません");
  }, 15000);

  it("前回の一覧が手元にあれば、そう伝える", async () => {
    // 鍵も形も書き写さない。本番と同じ関数で置く
    writeCachedModels([MODEL] as never);
    expect(readCachedModels()).toHaveLength(1);
    installFetch({
      models: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderShell();

    const notice = await screen.findByRole("status", {}, { timeout: 8000 });
    expect(notice.textContent).toContain("前回の一覧");
  }, 15000);

  it("再試行を押すと取り直し、通れば消える", async () => {
    let failing = true;
    const { modelCalls } = installFetch({
      models: () => {
        if (failing) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ models: [MODEL] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const user = renderShell();

    await screen.findByRole("status", {}, { timeout: 8000 });
    const before = modelCalls();
    failing = false;
    await user.click(screen.getByRole("button", { name: "再試行" }));

    await waitFor(
      () => expect(screen.queryByRole("status")).toBeNull(),
      { timeout: 8000 },
    );
    // 押したぶん、実際に取り直している
    expect(modelCalls()).toBeGreaterThan(before);
  }, 15000);

  it("成功しているあいだは何も出さない", async () => {
    installFetch({});
    renderShell();
    // モデルが読めた（＝キャッシュに書かれた）ことを待ってから、帯が無いことを見る
    await waitFor(() => expect(readCachedModels()).toHaveLength(1));
    expect(screen.queryByRole("status")).toBeNull();
  }, 15000);
});

/**
 * 会話一覧の鮮度。
 *
 * 一覧（並び順・新しい会話・タイトル）はローダーが持っていて、遷移では
 * 取り直さない決まりになっている（重いローダーを全遷移の裏で待たせない
 * ため）。そのため**送信した会話が一番上に上がらず**、再読込するまで前の
 * 並びのままだった。動いたかどうかだけを短い間隔で受け取り、変わった
 * ときだけ取り直す。
 */
describe("会話一覧の取り直し", () => {
  /** 初回の描画ぶんを差し引いて、取り直しの回数だけを数える。 */
  async function settle(loads: () => number): Promise<number> {
    await new Promise((r) => setTimeout(r, 80));
    return loads();
  }

  it("何も動いていないうちは取り直さない", async () => {
    let loads = 0;
    installFetch({ unread: () => ({ ids: [], generating: [], latest: 100 }) });
    renderShell({ onLoad: () => loads++ });

    // 最初の取得は「いまの値」を控えるだけ（開いた直後に取り直さない）
    const base = await settle(() => loads);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await settle(() => loads)).toBe(base);
  });

  it("一覧が動いたら取り直す", async () => {
    let latest = 100;
    let loads = 0;
    installFetch({ unread: () => ({ ids: [], generating: [], latest }) });
    renderShell({ onLoad: () => loads++ });
    const base = await settle(() => loads);

    // 別の画面（や別の端末）で会話が動いた
    latest = 200;
    // 印の引き直しは5秒おきだが、他アプリから戻ったときは即座に反映する
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(loads).toBe(base + 1));

    // 同じ値のままなら、何度引いても取り直さない
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await settle(() => loads)).toBe(base + 1);
  });
});
