import { beforeEach, describe, expect, it } from "vitest";
import { createRoutesStub, Outlet } from "react-router";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Settings from "../../app/routes/settings";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../../app/lib/settings";
import { TEST_MODEL } from "./helpers/chat-harness";

/**
 * 設定の保存の順序（監査 P-1）。
 *
 * 以前は onChange のたびに PATCH を投げ、返事で欄を上書きしていた。
 * 返事が逆順に着くと、打っている最中の欄が古い値に巻き戻り、数値では
 * 「100」と打つ途中の 1 や 10 が最後に着いて保存されうる。
 *
 * ここでは**返事を止めておいて**打ち込み、返事を逆順に解く。最終的な
 * 表示と、送った PATCH の並びが「最後に打った値」で終わることを見る。
 * 返事を即座に返すスタブでは、この順序の問題はどう書いても再現しない。
 */
let patches: Partial<AppSettings>[];
let release: ((settings: AppSettings) => void)[];

function renderSettings() {
  patches = [];
  release = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/settings") && init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Partial<AppSettings>;
      patches.push(patch);
      return new Promise<Response>((resolve) => {
        release.push((settings) =>
          resolve(
            new Response(JSON.stringify({ settings }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        );
      });
    }
    return new Response(JSON.stringify({ settings: DEFAULT_APP_SETTINGS }), {
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
});

describe("保存の順序", () => {
  it("打っている最中の欄は、遅れて着いた古い返事で巻き戻らない", async () => {
    const user = renderSettings();
    const box = screen.getByLabelText("既定のシステムプロンプト") as HTMLTextAreaElement;
    await user.type(box, "あい");
    // 変更はまとめて1本になる。返事はまだ止めてある
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ defaultSystemPrompt: "あい" });

    // 返事を待っているあいだに続きを打つ
    await user.type(box, "う");
    expect(box.value).toBe("あいう");

    // 古い返事（「あい」）が着く。欄は「あいう」のまま
    release[0]({ ...DEFAULT_APP_SETTINGS, defaultSystemPrompt: "あい" });
    await waitFor(() => expect(patches.length).toBe(2));
    expect(box.value).toBe("あいう");
    // 2本目は前の返事が着いてから出ていて、最後の値を運ぶ
    expect(patches[1]).toEqual({ defaultSystemPrompt: "あいう" });

    release[1]({ ...DEFAULT_APP_SETTINGS, defaultSystemPrompt: "あいう" });
    await waitFor(() => expect(screen.getAllByText("保存しました").length).toBeGreaterThan(0));
    expect(box.value).toBe("あいう");
  });

  it("要求は前の返事が着くまで重ねない（D1 の後勝ちで途中の値が残らない）", async () => {
    const user = renderSettings();
    const box = screen.getByLabelText("既定のシステムプロンプト");
    await user.type(box, "a");
    await waitFor(() => expect(patches.length).toBe(1));
    await user.type(box, "b");
    await user.type(box, "c");
    // 返事を解くまで2本目は出ない
    await new Promise((r) => setTimeout(r, 500));
    expect(patches.length).toBe(1);
    release[0]({ ...DEFAULT_APP_SETTINGS, defaultSystemPrompt: "a" });
    await waitFor(() => expect(patches.length).toBe(2));
    expect(patches[1]).toEqual({ defaultSystemPrompt: "abc" });
  });
});
