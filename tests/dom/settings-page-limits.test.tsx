import { beforeEach, describe, expect, it } from "vitest";
import { createRoutesStub, Outlet } from "react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";
import Settings from "../../app/routes/settings";
import {
  DEFAULT_APP_SETTINGS,
  PAGE_MAX_CHARS_RANGE,
  PAGE_MAX_PAGES_RANGE,
  type AppSettings,
} from "../../app/lib/settings";
import { TEST_MODEL } from "./helpers/chat-harness";

/**
 * 設定画面の「リンクの取り込み」。
 *
 * ここで変えた値は、入力欄（何本まで・何字まで）とサーバー（何MBまで・
 * 何秒まで）の両方が見る。**画面に出ているのに効かない**という壊れ方を
 * するので、送っている中身まで見る。
 */
const patches: Partial<AppSettings>[] = [];

function renderSettings(settings: Partial<AppSettings> = {}) {
  const merged = { ...DEFAULT_APP_SETTINGS, ...settings };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("/api/settings") && init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)) as Partial<AppSettings>);
    }
    return new Response(JSON.stringify({ settings: merged }), {
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
  patches.length = 0;
  localStorage.clear();
});

describe("リンクの取り込みの上限", () => {
  it("4つとも、いまの値が出る", () => {
    renderSettings({
      pageMaxPages: 3,
      pageMaxChars: 12_000,
      pageMaxMb: 4,
      pageTimeoutSec: 30,
    });
    const value = (label: string) =>
      (screen.getByLabelText(label) as HTMLInputElement).value;
    expect(value("1通に取り込む本数")).toBe("3");
    expect(value("1本あたりの長さ")).toBe("12000");
    expect(value("取ってくる大きさ（MB）")).toBe("4");
    expect(value("待つ時間（秒）")).toBe("30");
  });

  it("変えると、その項目だけを保存する", async () => {
    const user = renderSettings();
    const box = screen.getByLabelText("1通に取り込む本数");
    await user.clear(box);
    await user.type(box, "2");
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches.at(-1)).toEqual({ pageMaxPages: 2 });
  });

  /**
   * 範囲の外は入口で止める。0 は「取り込まない」という意味を持つので、
   * 下限として受け付けられること（下限が1に上がっていないこと）も見る。
   */
  it("受け付ける範囲が入力欄にも出ている", () => {
    renderSettings();
    const pages = screen.getByLabelText("1通に取り込む本数");
    expect(pages.getAttribute("min")).toBe(String(PAGE_MAX_PAGES_RANGE.min));
    expect(PAGE_MAX_PAGES_RANGE.min).toBe(0);
    expect(pages.getAttribute("max")).toBe(String(PAGE_MAX_PAGES_RANGE.max));
    const chars = screen.getByLabelText("1本あたりの長さ");
    expect(chars.getAttribute("min")).toBe(String(PAGE_MAX_CHARS_RANGE.min));
    expect(chars.getAttribute("max")).toBe(String(PAGE_MAX_CHARS_RANGE.max));
  });
});
