import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  installServer,
  renderChat,
  TEST_MODEL,
  type ServerStub,
} from "./helpers/chat-harness";
import type { BotRow } from "../../app/lib/db.server";
import type { ModelInfo } from "../../app/lib/openrouter.server";
import { COMPOSER_TEXT } from "../../app/components/chat/Composer";

/**
 * 入力欄の冒頭に書く宛先（`@ボット名`）。
 *
 * 見るのは3つ:
 * - 候補が出て、選ぶと本文の冒頭に差し込まれること（後ろは消えない）
 * - 宛先が本文と見分けられること（色分けの帯）
 * - **その1通が宛先のボットの設定で飛ぶこと**（ここが本体。画面上は
 *   何も変わらないので、通信の中身で見る）
 */

const BOT_MODEL: ModelInfo = {
  ...TEST_MODEL,
  id: "anthropic/claude-sonnet",
  name: "Claude Sonnet",
};

/** 画像を出せるモデル。「成功するまで生成」はこれのときだけ効く。 */
const IMAGE_MODEL: ModelInfo = {
  ...TEST_MODEL,
  id: "openai/gpt-image",
  name: "GPT Image",
  outputModalities: ["image"],
};

const bot = (over: Partial<BotRow> = {}): BotRow => ({
  id: "bot-1",
  name: "翻訳",
  icon: "🌐",
  model_id: BOT_MODEL.id,
  system_prompt: "あなたは翻訳者です。",
  params_json: null,
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
  }),
];

const options = { bots: BOTS, models: [TEST_MODEL, BOT_MODEL] };

let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const list = () => screen.queryByRole("listbox", { name: "宛先のボット" });

describe("候補の出し方", () => {
  it("@ を打つと候補が出て、選ぶと宛先が入る", async () => {
    const { user } = renderChat(options);
    expect(list()).toBeNull();

    await user.type(box(), "@");
    const panel = await screen.findByRole("listbox", { name: "宛先のボット" });
    expect(
      within(panel)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toHaveLength(BOTS.length);

    await user.click(within(panel).getByText("検索係"));
    expect(box().value).toBe("@検索係 ");
  });

  it("打つほど候補が絞られる", async () => {
    const { user } = renderChat(options);
    await user.type(box(), "@翻");
    const panel = await screen.findByRole("listbox", { name: "宛先のボット" });
    const shown = within(panel)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(shown).toHaveLength(2);
    expect(shown.some((t) => t?.includes("検索係"))).toBe(false);
  });

  it("すでに書いた文章の冒頭に @ を足すと、後ろを残したまま差し込める", async () => {
    const { user } = renderChat(options);
    await user.type(box(), "これを訳して");
    // 冒頭へ戻って @ を打つ
    box().setSelectionRange(0, 0);
    await user.type(box(), "@", { initialSelectionStart: 0, initialSelectionEnd: 0 });
    expect(box().value).toBe("@これを訳して");

    const panel = await screen.findByRole("listbox", { name: "宛先のボット" });
    await user.click(within(panel).getByText("翻訳", { exact: true }));
    expect(box().value).toBe("@翻訳 これを訳して");
  });

  it("指を置いただけでは確定しない（一覧を送れる）", async () => {
    /*
      確定を pointerdown で拾っていたころは、一覧をスクロールしようと
      指を置いた**その瞬間に**選ばれ、指の端末では一覧を送れなかった。
      押し込みではなくタップ（click）で確定する。
    */
    const { user } = renderChat(options);
    await user.type(box(), "@");
    const panel = await screen.findByRole("listbox", { name: "宛先のボット" });
    const row = within(panel).getByText("検索係");

    fireEvent.pointerDown(row);
    fireEvent.touchMove(panel);
    expect(box().value).toBe("@");

    await user.click(row);
    expect(box().value).toBe("@検索係 ");
  });

  it("一覧を指で送っても、入力欄のフォーカスは外れない", async () => {
    /*
      モデル選択の一覧を真似て touchmove で blur していたころは、
      候補をスワイプするとキーボードが畳まれて画面が動いた。あちらが
      外すのはパネルの中の検索欄で、ここで外れるのは本文の入力欄
      ——眺めているだけなのに書きかけの場所を見失う。
    */
    const { user } = renderChat(options);
    await user.type(box(), "@");
    const panel = await screen.findByRole("listbox", { name: "宛先のボット" });
    expect(document.activeElement).toBe(box());

    fireEvent.touchStart(panel);
    fireEvent.touchMove(panel);
    fireEvent.touchEnd(panel);
    expect(document.activeElement).toBe(box());
    // 一覧の中でスクロールを閉じる指定も外れていない
    expect(panel.className).toContain("overscroll-contain");
    expect(panel.className).toContain("touch-pan-y");
  });

  it("本文を打ち始めたら候補は引っ込む", async () => {
    const { user } = renderChat(options);
    await user.type(box(), "@翻訳");
    expect(list()).not.toBeNull();
    await user.type(box(), " これを");
    await waitFor(() => expect(list()).toBeNull());
  });

  it("↑↓ と Tab で選べる", async () => {
    const { user } = renderChat(options);
    await user.type(box(), "@");
    await screen.findByRole("listbox", { name: "宛先のボット" });
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.keyboard("{Tab}");
    expect(box().value).toBe("@翻訳（英語） ");
  });

  it("名前と関係ない書き出しでは、Enter が送信のままになる", async () => {
    // `@media` のような書き出しで先頭の候補を選んでしまうと、
    // 送るつもりの Enter がボットの確定に化ける
    const { user } = renderChat(options);
    await user.type(box(), "@media の書き方を教えて");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    expect(
      (server.lastBody("/generate") as { userContent: string }).userContent,
    ).toBe("@media の書き方を教えて");
  });
});

describe("宛先の見分け", () => {
  it("宛先が決まると色分けの帯に名前が入る", async () => {
    const { user } = renderChat(options);
    const mark = () => screen.getByTestId("mention-mark");

    await user.type(box(), "@翻");
    // まだ決まっていない（打ちかけ）ので帯は空
    expect(mark().textContent).toBe("");

    await user.type(box(), "訳 これを訳して");
    expect(mark().textContent).toBe("@翻訳");
    // 帯の隣に本文が残っている（帯だけになっていない）
    expect(mark().parentElement?.textContent).toBe("@翻訳 これを訳して");
  });

  it("宛先の行にモデルが出て、解除で本文だけが残る", async () => {
    const { user } = renderChat(options);
    await user.type(box(), "@翻訳 これを訳して");
    expect(screen.getByText(/Claude Sonnet/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "解除" }));
    expect(box().value).toBe("これを訳して");
    expect(screen.getByTestId("mention-mark").textContent).toBe("");
  });

  /**
   * 色分けの板は textarea の**裏**に敷いてあり、字送りと余白が同じで
   * ある限りにおいてだけ文字と重なる。片方の余白を変えると、帯だけが
   * ずれる——画面にエラーは出ず、テストも（見た目を見ないので）
   * 通ってしまう。ここで結び付きを見張る。
   */
  it("色分けの板と入力欄は、同じ字送り・余白を使っている", () => {
    renderChat(options);
    const overlay = screen.getByTestId("mention-mark").parentElement!;
    const shared = COMPOSER_TEXT.split(" ");
    for (const cls of shared) {
      expect(overlay.className.split(" ")).toContain(cls);
      expect(box().className.split(" ")).toContain(cls);
    }
    // 片方だけに余白・字送りの指定が増えていないか
    const layout = (el: Element) =>
      el.className
        .split(" ")
        .filter((c) => /^(p[xytblrse]?-|leading-|tracking-|text-\[|font-)/.test(c))
        .sort();
    expect(layout(overlay)).toEqual(layout(box()));
  });
});

describe("宛先へ送る", () => {
  it("その1通だけ、宛先のモデルとシステムプロンプトで生成する", async () => {
    const { user } = renderChat({
      ...options,
      systemPrompt: "会話のシステムプロンプト",
    });
    await user.type(box(), "@翻訳 これを訳して");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    const body = server.lastBody("/generate") as {
      model: string;
      messages: { role: string; content: string }[];
      userContent: string;
    };
    expect(body.model).toBe(BOT_MODEL.id);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "あなたは翻訳者です。",
    });
    // 本文はそのまま残す（誰に宛てたのかが後から読める）
    expect(body.userContent).toBe("@翻訳 これを訳して");
  });

  it("次の1通は、宛先を書かなければ会話のモデルへ戻る", async () => {
    const { user } = renderChat({
      ...options,
      systemPrompt: "会話のシステムプロンプト",
    });
    await user.type(box(), "@翻訳 これを訳して");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));

    await user.type(box(), "ありがとう");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(server.countOf("/generate")).toBe(2));
    const body = server.lastBody("/generate") as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe(TEST_MODEL.id);
    expect(body.messages[0].content).toBe("会話のシステムプロンプト");
  });

  it("宛先のパラメータで生成する（会話のものを持ち込まない）", async () => {
    /*
      生成パラメータはプロバイダごとに別物なので、会話の値をそのまま
      別のボットへ持ち込むと意味の無い（ときには弾かれる）指定になる。
      宛先が付いた1通は、そのボットの設定だけで走る
    */
    const tuned = bot({
      id: "bot-4",
      name: "几帳面",
      params_json: JSON.stringify({ temperature: "0.1" }),
    });
    const { user } = renderChat({
      ...options,
      bots: [...BOTS, tuned],
      initialParams: { temperature: "1.9" },
    });
    await user.type(box(), "@几帳面 これを");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    expect(
      (server.lastBody("/generate") as { params: Record<string, string> })
        .params,
    ).toEqual({ temperature: "0.1" });
  });

  it("宛先のボットが「成功するまで生成」なら、走り出す前に確認を出す", async () => {
    /*
      何度も投げる＝そのぶん課金される。会話側の設定では出ない確認が、
      宛先のボットの設定では要る——ここを会話の状態だけで見ていると、
      黙って何度も課金される
    */
    const painter = bot({
      id: "bot-5",
      name: "絵師",
      model_id: IMAGE_MODEL.id,
      params_json: JSON.stringify({
        retry: "on",
        retryTarget: "2",
        retryMax: "4",
      }),
    });
    const { user } = renderChat({
      ...options,
      bots: [...BOTS, painter],
      models: [TEST_MODEL, BOT_MODEL, IMAGE_MODEL],
    });
    await user.type(box(), "@絵師 ねこの絵");
    await user.keyboard("{Enter}");

    expect(await screen.findByText("成功するまで生成します")).toBeTruthy();
    // 確認に出す数字とモデルは、実際に走るもの（＝宛先のもの）
    expect(screen.getByText("2件")).toBeTruthy();
    expect(screen.getByText(IMAGE_MODEL.name)).toBeTruthy();
    expect(server.countOf("/generate")).toBe(0);

    await user.click(screen.getByRole("button", { name: "実行" }));
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
  });

  it("会話がまだ無いときは、宛先がその会話の担当ボットになる", async () => {
    const { user } = renderChat({ ...options, conversationId: null });
    await user.type(box(), "@翻訳 これを訳して");
    await user.keyboard("{Enter}");

    // countOf は部分一致なので、生成（/api/conversations/:id/generate）
    // まで数えてしまう。会話の作成だけを取り出す
    const creations = () =>
      server.calls.filter(
        (c) => c.method === "POST" && c.path.endsWith("/api/conversations"),
      );
    await waitFor(() => expect(creations()).toHaveLength(1));
    const created = creations()[0].body as {
      botId?: string;
      modelId: string;
    };
    expect(created.botId).toBe("bot-1");
    expect(created.modelId).toBe(BOT_MODEL.id);
  });
});
