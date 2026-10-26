import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import {
  installServer,
  renderChat,
  TEST_MODEL,
  type ServerStub,
} from "./helpers/chat-harness";
import type { BotRow } from "../../app/lib/db.server";
import type { ModelInfo } from "../../app/lib/openrouter.server";

/**
 * 入力欄のモデル一覧でボットを選ぶ（会話の担当ボットの差し替え）。
 *
 * `@ボット名` が1通だけなのに対し、こちらは会話に残る。見るのは:
 * - 一覧にボットの節が出て、名前でも**使うモデル**でも引けること
 * - 選んだあとの送信が、`@` を書かなくてもそのボットの設定で飛ぶこと
 *   （画面上は印が変わるだけなので、通信の中身で見る）
 * - 会話に残すこと（PATCH）と、外したときに戻るもの・残るもの
 */

const BOT_MODEL: ModelInfo = {
  ...TEST_MODEL,
  id: "anthropic/claude-sonnet",
  name: "Claude Sonnet",
};

const bot = (over: Partial<BotRow> = {}): BotRow => ({
  id: "bot-1",
  name: "翻訳",
  icon: "🌐",
  model_id: BOT_MODEL.id,
  system_prompt: "あなたは翻訳者です。",
  params_json: JSON.stringify({ temperature: "0.1" }),
  created_at: 0,
  updated_at: 0,
  ...over,
});

const BOTS = [
  bot(),
  bot({ id: "bot-2", name: "翻訳（英語）", icon: "🇬🇧" }),
  bot({
    id: "bot-3",
    name: "検索係",
    icon: "🔍",
    model_id: TEST_MODEL.id,
    system_prompt: "調べものを手伝います。",
    params_json: null,
  }),
];

const options = {
  bots: BOTS,
  models: [TEST_MODEL, BOT_MODEL],
  initialModel: TEST_MODEL.id,
  systemPrompt: "会話のシステムプロンプト",
  initialParams: { temperature: "1.9" },
};

let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
/** 入力欄のモデルのチップ（名前はいま選んでいるモデル）。 */
const chip = (name: RegExp = /GPT-4o mini/) =>
  screen.getByRole("button", { name });
/** 一覧のボットの行。読み上げの名前は「名前（使うモデル）」。 */
const botRow = (name: string) =>
  screen.queryByRole("button", { name: new RegExp(`^${name}（[^）]*）$`) });

type GenerateBody = {
  model: string;
  params: Record<string, string>;
  messages: { role: string; content: string }[];
  userContent: string;
  /** system に入れたプロンプトの元のボット（そのファイルをサーバーが足す）。 */
  botFiles: { botId: string; fromConversation: boolean } | null;
};

async function send(
  user: ReturnType<typeof renderChat>["user"],
  text: string,
  nth: number,
) {
  await user.type(box(), text);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(server.countOf("/generate")).toBe(nth));
  return server.lastBody("/generate") as GenerateBody;
}

const patches = () =>
  server.calls
    .filter((c) => c.method === "PATCH")
    .map((c) => ({ path: c.path, body: c.body as Record<string, unknown> }));

describe("一覧のボットの節", () => {
  it("モデルの一覧の先頭にボットが並ぶ（モデルも並んだまま）", async () => {
    const { user } = renderChat(options);
    await user.click(chip());
    expect(screen.getByText("ボット")).toBeInTheDocument();
    for (const b of BOTS) expect(botRow(b.name)).not.toBeNull();
    // ボットの行には使うモデルが出る
    expect(botRow("翻訳（英語）")?.textContent).toContain("Claude Sonnet");
    // モデルの行も消えていない（節を足したせいで一覧が空にならない）
    expect(
      screen.getAllByRole("button", { name: /Claude Sonnet/ }).length,
    ).toBeGreaterThan(BOTS.filter((b) => b.model_id === BOT_MODEL.id).length);
  });

  it("ボットが使うモデルの名前でも引ける", async () => {
    const { user } = renderChat(options);
    await user.click(chip());
    await user.type(screen.getByRole("textbox", { name: "モデルを検索" }), "sonnet");
    await waitFor(() => expect(botRow("検索係")).toBeNull());
    expect(botRow("翻訳")).not.toBeNull();
    expect(botRow("翻訳（英語）")).not.toBeNull();
  });

  it("モデルのIDでも引ける", async () => {
    const { user } = renderChat(options);
    await user.click(chip());
    await user.type(
      screen.getByRole("textbox", { name: "モデルを検索" }),
      "gpt-4o-mini",
    );
    await waitFor(() => expect(botRow("翻訳")).toBeNull());
    expect(botRow("検索係")).not.toBeNull();
  });

  it("語はすべて当たったものだけ残す（名前とモデルにまたがってもよい）", async () => {
    const { user } = renderChat(options);
    await user.click(chip());
    const search = screen.getByRole("textbox", { name: "モデルを検索" });
    // 「翻訳」は名前、「sonnet」はモデルに当たる
    await user.type(search, "翻訳 sonnet");
    await waitFor(() => expect(botRow("検索係")).toBeNull());
    expect(botRow("翻訳")).not.toBeNull();

    // 「mini」は検索係のモデルに当たるが、「翻訳」は当たらない
    await user.clear(search);
    await user.type(search, "翻訳 mini");
    await waitFor(() => expect(botRow("翻訳")).toBeNull());
    expect(botRow("検索係")).toBeNull();
    expect(botRow("翻訳（英語）")).toBeNull();
    // 一覧そのものは開いたまま（検索欄が残っている）
    expect(search).toBeInTheDocument();
  });

  it("使うモデルが一覧から消えたボットは選べない", async () => {
    const gone = bot({ id: "bot-9", name: "引退", model_id: "old/model" });
    const { user } = renderChat({ ...options, bots: [...BOTS, gone] });
    await user.click(chip());
    const row = botRow("引退")!;
    expect(row).toBeDisabled();
    expect(row.textContent).toContain("一覧に無いモデル");
    // 隣のボットは選べる
    expect(botRow("翻訳")).toBeEnabled();
  });
});

describe("既存の会話でボットを選ぶ", () => {
  it("会話に残し、`@` を書かなくてもそのボットの設定で送る", async () => {
    const { user } = renderChat(options);
    await user.click(chip());
    await user.click(botRow("翻訳")!);

    await waitFor(() =>
      expect(patches()).toContainEqual({
        path: "/api/conversations/conv-1",
        body: { botId: "bot-1" },
      }),
    );
    // チップは選んだボットの印とモデルに替わる
    const now = chip(/Claude Sonnet/);
    expect(within(now).getByText("🌐")).toBeInTheDocument();

    const first = await send(user, "これを訳して", 1);
    expect(first.model).toBe(BOT_MODEL.id);
    expect(first.messages[0]).toEqual({
      role: "system",
      content: "あなたは翻訳者です。",
    });
    expect(first.params).toEqual({ temperature: "0.1" });
    expect(first.userContent).toBe("これを訳して");
    expect(first.botFiles).toEqual({ botId: "bot-1", fromConversation: true });

    // 1通で終わらない（宛先との違い）
    const second = await send(user, "もう一つ", 2);
    expect(second.model).toBe(BOT_MODEL.id);
    expect(second.messages[0].content).toBe("あなたは翻訳者です。");
  });

  it("`@` の宛先はその1通だけ上書きし、次は選んだボットへ戻る", async () => {
    const { user } = renderChat(options);
    await user.click(chip());
    await user.click(botRow("翻訳")!);

    const once = await send(user, "@検索係 調べて", 1);
    expect(once.model).toBe(TEST_MODEL.id);
    expect(once.messages[0].content).toBe("調べものを手伝います。");
    // ファイルも宛先のボットのいまのもの（プロンプトと同じ選び方）
    expect(once.botFiles).toEqual({ botId: "bot-3", fromConversation: false });

    const back = await send(user, "ありがとう", 2);
    expect(back.model).toBe(BOT_MODEL.id);
    expect(back.messages[0].content).toBe("あなたは翻訳者です。");
    expect(back.botFiles).toEqual({ botId: "bot-1", fromConversation: true });
  });

  it("待たせている⚙の保存は捨てる（ボットのパラメータを古い値で上書きしない）", async () => {
    const { user } = renderChat(options);
    // ⚙で変更する（保存は 600ms 溜めてから送る）
    await user.click(screen.getByRole("button", { name: "生成パラメータ" }));
    await user.click(screen.getByRole("button", { name: "初期設定に戻す" }));
    await user.click(await screen.findByRole("button", { name: "戻す" }));
    await user.click(screen.getByRole("button", { name: "生成パラメータ" }));

    await user.click(chip());
    await user.click(botRow("翻訳")!);
    await waitFor(() =>
      expect(patches().some((p) => p.body.botId === "bot-1")).toBe(true),
    );
    // 溜めの時間が過ぎても、パラメータの保存は出ていない
    await new Promise((r) => setTimeout(r, 800));
    expect(patches().filter((p) => "params" in p.body)).toEqual([]);
    // 画面の側もボットの値になっている
    const body = await send(user, "これを訳して", 1);
    expect(body.params).toEqual({ temperature: "0.1" });
  });

  it("× で外すとプロンプトはアプリ既定へ戻り、モデルは残る", async () => {
    const { user } = renderChat({
      ...options,
      settings: { defaultSystemPrompt: "既定のプロンプト" },
    });
    await user.click(chip());
    await user.click(botRow("翻訳")!);
    await user.click(screen.getByRole("button", { name: "ボットの選択を解除" }));

    await waitFor(() =>
      expect(patches()).toContainEqual({
        path: "/api/conversations/conv-1",
        body: { botId: null },
      }),
    );
    // 印は消えるが、チップ（モデル）は残る
    const now = chip(/Claude Sonnet/);
    expect(within(now).queryByText("🌐")).toBeNull();

    const body = await send(user, "つづき", 1);
    expect(body.model).toBe(BOT_MODEL.id);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "既定のプロンプト",
    });
    // 外したボットの資料は付けない
    expect(body.botFiles).toBeNull();
  });

  it("元から担当のボットが居る会話でも × で外せる", async () => {
    const { user } = renderChat({
      ...options,
      bot: {
        id: "bot-3",
        name: "検索係",
        icon: "🔍",
        systemPrompt: "調べものを手伝います。",
        params: null,
      },
    });
    await user.click(screen.getByRole("button", { name: "ボットの選択を解除" }));
    await waitFor(() =>
      expect(patches().some((p) => p.body.botId === null)).toBe(true),
    );
  });

  it("元から担当のボットが居る会話は、そのボットの写しを使うと申告する", async () => {
    const { user } = renderChat({
      ...options,
      bot: {
        id: "bot-3",
        name: "検索係",
        icon: "🔍",
        systemPrompt: "調べものを手伝います。",
        params: null,
      },
    });
    const body = await send(user, "調べて", 1);
    expect(body.botFiles).toEqual({ botId: "bot-3", fromConversation: true });
  });

  it("ボットの居ない会話では申告しない", async () => {
    const { user } = renderChat(options);
    const body = await send(user, "こんにちは", 1);
    expect(body.botFiles).toBeNull();
  });
});

describe("まだ会話が無いとき", () => {
  it("ホームが受け取るなら、ランチャーと同じ経路へ渡す", async () => {
    const picked = vi.fn();
    const { user } = renderChat({
      ...options,
      conversationId: null,
      onSelectBot: picked,
    });
    await user.click(chip());
    await user.click(botRow("翻訳（英語）")!);
    expect(picked).toHaveBeenCalledTimes(1);
    expect(picked.mock.calls[0][0]).toMatchObject({ id: "bot-2" });
    // 会話がまだ無いので、会話への書き込みは出ない
    expect(patches()).toEqual([]);
  });

  it("受け取り手が無ければ、その場で選んで会話をボット付きで作る", async () => {
    const { user } = renderChat({ ...options, conversationId: null });
    await user.click(chip());
    await user.click(botRow("翻訳")!);

    const body = await send(user, "これを訳して", 1);
    expect(body.model).toBe(BOT_MODEL.id);
    const created = server.calls.find(
      (c) => c.method === "POST" && c.path === "/api/conversations",
    )?.body as { botId?: string; modelId: string };
    expect(created.botId).toBe("bot-1");
    expect(created.modelId).toBe(BOT_MODEL.id);
  });
});
