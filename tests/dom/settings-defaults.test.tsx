import { beforeEach, describe, expect, it } from "vitest";
import { createRoutesStub, Outlet } from "react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Settings from "../../app/routes/settings";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../../app/lib/settings";
import {
  clearLastUsedModel,
  readLastUsedModel,
  writeLastUsedModel,
} from "../../app/lib/persisted";
import { TEST_MODEL } from "./helpers/chat-harness";
import type { ModelInfo } from "../../app/lib/openrouter.server";

/**
 * 設定画面の「新規チャットの既定」（監査 G-10）。
 *
 * モデルの既定だけは、その端末で最後に使ったものに負ける。設定を変えても
 * 画面が変わらないので、**黙っていると壊れているように見える**。いま
 * 効いている側と、戻す手立てをここに出しているかを見張る。
 */
const OTHER: ModelInfo = {
  ...TEST_MODEL,
  id: "anthropic/other-model",
  name: "べつのモデル",
};

function renderSettings(settings: Partial<AppSettings>) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ settings: { ...DEFAULT_APP_SETTINGS, ...settings } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const shell = {
    models: [TEST_MODEL, OTHER],
    bots: [],
    usdJpy: 150,
    settings: { ...DEFAULT_APP_SETTINGS, ...settings },
    openSidebar: () => {},
  };
  const loaderData = {
    settings: { ...DEFAULT_APP_SETTINGS, ...settings },
    now: 1_700_000_000_000,
  };
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => <Outlet context={shell} />,
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
  clearLastUsedModel();
});

describe("既定のモデルの見え方", () => {
  it("端末の記憶が無ければ、断り書きは出ない", () => {
    renderSettings({ defaultModelId: OTHER.id });
    expect(screen.queryByText(/この端末では/)).toBeNull();
    // 節そのものは出ている（無いことだけを見ない）
    expect(screen.getByText("新規チャットの既定")).toBeTruthy();
  });

  it("端末の記憶があると、いま効いている側を知らせる", () => {
    writeLastUsedModel(TEST_MODEL.id);
    renderSettings({ defaultModelId: OTHER.id });
    const notice = screen.getByText(/この端末では/);
    expect(notice.textContent).toContain(TEST_MODEL.name);
  });

  it("記憶を消すと、その場で断り書きが消える", async () => {
    writeLastUsedModel(TEST_MODEL.id);
    const user = renderSettings({ defaultModelId: OTHER.id });

    await user.click(screen.getByRole("button", { name: "この端末の記憶を消す" }));
    await waitFor(() => expect(screen.queryByText(/この端末では/)).toBeNull());
    expect(readLastUsedModel()).toBeNull();
  });

  /**
   * 指定した既定が一覧から消える（提供終了・名前変更）と、新規チャットは
   * 黙って別のモデルで始まる。額が変わるので、気づける場所に出す。
   */
  it("既定が一覧から消えていたら知らせる", () => {
    renderSettings({ defaultModelId: "もう無いモデル" });
    expect(screen.getByText(/いまのモデル一覧にありません/)).toBeTruthy();
  });

  it("一覧にあるあいだは、その断り書きを出さない", () => {
    renderSettings({ defaultModelId: OTHER.id });
    expect(screen.queryByText(/いまのモデル一覧にありません/)).toBeNull();
  });
});
