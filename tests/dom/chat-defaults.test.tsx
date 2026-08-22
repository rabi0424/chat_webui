import { beforeEach, describe, expect, it } from "vitest";
import { createRoutesStub, Outlet } from "react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "../../app/routes/home";
import ChatRoute from "../../app/routes/chat.$id";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../../app/lib/settings";
import { DEFAULT_MODEL } from "../../app/lib/constants";
import { clearLastUsedModel, writeLastUsedModel } from "../../app/lib/persisted";
import { installServer, TEST_MODEL, type ServerStub } from "./helpers/chat-harness";
import type { ModelInfo } from "../../app/lib/openrouter.server";

/**
 * 新規チャットの既定（監査 G-10）。
 *
 * 既定のモデル・システムプロンプト・生成パラメータを設定できるように
 * したが、モデルだけは**その端末で最後に使ったもの**が優先される。
 * 選び直したモデルが次のチャットでも続く挙動を崩さないため。
 */
const OTHER: ModelInfo = {
  ...TEST_MODEL,
  id: "anthropic/other-model",
  name: "べつのモデル",
};
const BUILTIN: ModelInfo = { ...TEST_MODEL, id: DEFAULT_MODEL, name: "組み込み既定" };

function renderNewChat(settings: Partial<AppSettings>) {
  const shell = {
    models: [BUILTIN, TEST_MODEL, OTHER],
    bots: [],
    usdJpy: 150,
    settings: { ...DEFAULT_APP_SETTINGS, ...settings },
    openSidebar: () => {},
  };
  // 本物のホーム画面を描く。既定をどう渡すかはこのルートが決めている
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => <Outlet context={shell} />,
      children: [{ index: true, Component: Home }],
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
  clearLastUsedModel();
});

/** 直近の生成要求で、実際にサーバーへ渡った中身。 */
function lastGenerate(): {
  model: string;
  params: Record<string, unknown>;
  messages: { role: string; content: string }[];
} {
  return server.lastBody("/generate") as never;
}

describe("既定のモデル", () => {
  it("設定した既定で始まる", async () => {
    const user = renderNewChat({ defaultModelId: OTHER.id });
    await user.type(await screen.findByRole("textbox"), "やあ");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lastGenerate().model).toBe(OTHER.id));
  });

  /**
   * この端末で最後に使ったモデルが勝つ。ここが逆になると、モデルを
   * 選び直しても次のチャットで元に戻ってしまう。
   */
  it("端末で最後に使ったモデルのほうが優先される", async () => {
    writeLastUsedModel(TEST_MODEL.id);
    const user = renderNewChat({ defaultModelId: OTHER.id });
    await user.type(await screen.findByRole("textbox"), "やあ");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lastGenerate().model).toBe(TEST_MODEL.id));
  });

  it("端末の記憶を消すと、設定した既定に戻る", async () => {
    writeLastUsedModel(TEST_MODEL.id);
    clearLastUsedModel();
    const user = renderNewChat({ defaultModelId: OTHER.id });
    await user.type(await screen.findByRole("textbox"), "やあ");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lastGenerate().model).toBe(OTHER.id));
  });

  it("一覧に無い既定を指していたら、一覧の先頭で始まる", async () => {
    const user = renderNewChat({ defaultModelId: "もう無いモデル" });
    await user.type(await screen.findByRole("textbox"), "やあ");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lastGenerate().model).toBe(BUILTIN.id));
  });

  it("何も設定していなければ、組み込みの既定で始まる", async () => {
    const user = renderNewChat({});
    await user.type(await screen.findByRole("textbox"), "やあ");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(lastGenerate().model).toBe(DEFAULT_MODEL));
  });
});

describe("既定のシステムプロンプトと生成パラメータ", () => {
  it("システムプロンプトが先頭に入る", async () => {
    const user = renderNewChat({ defaultSystemPrompt: "結論から書いて" });
    await user.type(await screen.findByRole("textbox"), "やあ");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const sent = lastGenerate().messages;
      expect(sent[0]).toEqual({ role: "system", content: "結論から書いて" });
    });
  });

  it("空なら、system のメッセージ自体を入れない", async () => {
    const user = renderNewChat({ defaultSystemPrompt: "" });
    await user.type(await screen.findByRole("textbox"), "やあ");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(lastGenerate().messages.some((m) => m.role === "system")).toBe(
        false,
      );
    });
  });

  it("生成パラメータが初期値として渡る", async () => {
    const user = renderNewChat({ defaultParams: { temperature: 0.2 } });
    await user.type(await screen.findByRole("textbox"), "やあ");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(lastGenerate().params).toEqual({ temperature: 0.2 }),
    );
  });
});

/**
 * 既定は「会話を作った時点の写し」。あとで既定を変えても、既にある
 * 会話の前提は入れ替わらない（ボットと同じ規則）。写しではなくいまの
 * 設定を読んでしまうと、同じ会話の続きなのに指示が変わる。
 */
describe("既にある会話", () => {
  it("いまの既定ではなく、作ったときの写しを使う", async () => {
    const shell = {
      models: [TEST_MODEL],
      bots: [],
      usdJpy: 150,
      settings: { ...DEFAULT_APP_SETTINGS, defaultSystemPrompt: "新しい既定" },
      openSidebar: () => {},
    };
    const loaderData = {
      conversation: {
        id: "conv-1",
        title: "会話",
        model_id: TEST_MODEL.id,
        params_json: null,
        bot_id: null,
        bot_name: null,
        bot_icon: null,
        // 作ったときに写し取ったもの
        system_prompt: "作ったときの写し",
      },
      messages: [],
    };
    // 本物の会話ルートを描く。写しを渡すのはこのルートの仕事
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => <Outlet context={shell} />,
        children: [
          {
            index: true,
            Component: () => <ChatRoute {...({ loaderData } as never)} />,
          },
        ],
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
    const user = userEvent.setup();

    await user.type(await screen.findByRole("textbox"), "やあ");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(lastGenerate().messages[0]).toEqual({
        role: "system",
        content: "作ったときの写し",
      });
    });
  });
});
