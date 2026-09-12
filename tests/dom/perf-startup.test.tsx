import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import Shell from "../../app/routes/shell";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { currentBuildId, loadSamples } from "../../app/lib/perf";

/**
 * 起動の所要時間の記録。
 *
 * ページ遷移と違って、起動は**文書の読み込みごとに1回**しか測れない
 * （performance.now() の原点が文書の開始なので、測り直しができない）。
 * ここが外れても画面には何も出ず、遷移の数字だけが並び続けるので、
 * 「起動が遅くなった」に気づく手立てが無くなる。
 *
 * この確認は起動の記録が「文書ごとに1回」であることに依存するため、
 * **このファイルにテストを足すときは順番に注意**（shell.tsx の印は
 * モジュールに残り、2度目のマウントでは記録されない）。
 */
function renderShell() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
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
      children: [{ index: true, Component: () => <p>中身</p> }],
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

beforeEach(() => {
  localStorage.clear();
});

describe("起動の記録", () => {
  it("開いたら1件だけ記録され、ビルドと端末が付く", async () => {
    renderShell();
    await screen.findByText("中身");
    await waitFor(() => expect(loadSamples()).toHaveLength(1));

    const [startup] = loadSamples();
    expect(startup.path).toBe("(起動)");
    expect(startup.ms).toBeGreaterThanOrEqual(0);
    expect(startup.build).toBe(currentBuildId());
    expect(startup.mode).toBeTruthy();
    expect(startup.deviceId).toBeTruthy();

    // 同じ文書のまま作り直しても、起動は二重に記録しない
    cleanup();
    renderShell();
    await screen.findByText("中身");
    expect(loadSamples()).toHaveLength(1);
  });
});
