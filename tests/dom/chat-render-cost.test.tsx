import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  installServer,
  msg,
  renderChat,
  TEST_MODEL,
  type ServerStub,
} from "./helpers/chat-harness";
import type { ModelInfo } from "../../app/lib/openrouter.server";
import type { BotRow } from "../../app/lib/db.server";

/**
 * 会話の外側の操作で、吹き出しを描き直さないこと。
 *
 * ⚙パネル（生成パラメータ）の開け閉めや値の変更は Chat の状態を変えるので
 * Chat 全体が描き直される。以前はそのたびに会話の全吹き出しまで描き直して
 * いて、長い会話ではパネルの操作がもっさりしていた。画面の見た目は
 * 何も変わらないので、描いた回数を数えないと気づけない。
 *
 * 描き直さなくした仕掛け（一覧の memo と、同一性を保った関数）は、
 * 取り違えると「古い値のまま動く」形で壊れる。後半はその側を見る。
 */
const renders = vi.hoisted(() => ({
  count: 0,
  /** 応答の吹き出しを、行（ID）ごとに何回描いたか。 */
  assistant: new Map<string, number>(),
  /** こちらの発言の吹き出しを、行ごとに何回描いたか。 */
  user: new Map<string, number>(),
  /** 塊に分けた本文（splitBlocks に渡ったもの）。 */
  split: [] as string[],
  reset() {
    this.count = 0;
    this.assistant.clear();
    this.user.clear();
    this.split = [];
  },
}));
const bump = (map: Map<string, number>, id: string | undefined) =>
  map.set(id ?? "(no id)", (map.get(id ?? "(no id)") ?? 0) + 1);
vi.mock("../../app/components/chat/AssistantMessage", async (orig) => {
  const actual =
    await orig<typeof import("../../app/components/chat/AssistantMessage")>();
  return {
    ...actual,
    AssistantMessage: (props: Parameters<typeof actual.AssistantMessage>[0]) => {
      renders.count++;
      bump(renders.assistant, props.m.id);
      return actual.AssistantMessage(props);
    },
  };
});
vi.mock("../../app/components/chat/UserMessage", async (orig) => {
  const actual =
    await orig<typeof import("../../app/components/chat/UserMessage")>();
  return {
    ...actual,
    UserMessage: (props: Parameters<typeof actual.UserMessage>[0]) => {
      bump(renders.user, props.m.id);
      return actual.UserMessage(props);
    },
  };
});
/*
 * 塊に分けたかどうかは画面からは見分けられない（ReactMarkdown は囲みを
 * 作らないので、塊を並べても1つとして描いても同じ DOM になる）。
 * 違いが出るのは描く手間だけなので、分けに渡った本文を控えて見る。
 */
vi.mock("../../app/lib/markdown-blocks", async (orig) => {
  const actual = await orig<typeof import("../../app/lib/markdown-blocks")>();
  return {
    ...actual,
    splitBlocks: (src: string) => {
      renders.split.push(src);
      return actual.splitBlocks(src);
    },
  };
});

let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
  renders.reset();
});

/** 描いた回数の合計。 */
const total = (map: Map<string, number>) =>
  [...map.values()].reduce((a, b) => a + b, 0);

/** 初回の描画（段階的な描画を含む）が落ち着くのを待つ。 */
async function settle(): Promise<void> {
  await waitFor(() => expect(renders.count).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 100));
}

/** 往復を n 回ぶん並べる（u1, a1, u2, a2, …）。 */
function turns(n: number) {
  return Array.from({ length: n }, (_, k) => [
    msg("user", `質問${k + 1}`, { id: `u${k + 1}` }),
    msg("assistant", `答え${k + 1}です。\n\n続きの段落${k + 1}。`, {
      id: `a${k + 1}`,
    }),
  ]).flat();
}

const conversation = [
  msg("user", "一つ目の質問", { id: "u1" }),
  msg("assistant", "一つ目の答え", { id: "a1" }),
  msg("user", "二つ目の質問", { id: "u2" }),
  msg("assistant", "二つ目の答え", { id: "a2" }),
];

describe("吹き出しを描き直さない", () => {
  it("⚙パネルを開いて値を変え、閉じても、吹き出しは描き直さない", async () => {
    const { user } = renderChat({ conversationId: "c1", initialMessages: conversation });
    expect(await screen.findByText("二つ目の答え")).toBeInTheDocument();
    // 初回の描画（段階的な描画を含む）が落ち着いてから数え始める
    await waitFor(() => expect(renders.count).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    renders.count = 0;

    await user.click(screen.getByRole("button", { name: "生成パラメータ" }));
    await user.click(
      await screen.findByRole("button", { name: "Temperatureを手動設定" }),
    );
    // 値が本当に変わったこと（変わっていなければ描き直さないのは当然）
    expect(
      screen.getByRole("button", { name: "Temperatureを自動に戻す" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("変更あり")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Temperatureを自動に戻す" }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByText("この会話にのみ適用されます")).toBeNull();

    expect(renders.count).toBe(0);
    // 一覧が消えたから数が 0 なのではないこと
    expect(screen.getByText("一つ目の答え")).toBeInTheDocument();
    expect(screen.getByText("二つ目の答え")).toBeInTheDocument();
  });

  it("入力欄に打っても、吹き出しは描き直さない", async () => {
    const { user } = renderChat({ conversationId: "c1", initialMessages: conversation });
    expect(await screen.findByText("二つ目の答え")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    renders.count = 0;

    await user.type(screen.getByRole("textbox"), "つづき");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("つづき");

    expect(renders.count).toBe(0);
    expect(screen.getByText("二つ目の答え")).toBeInTheDocument();
  });
});

describe("シェルの読み込み直し", () => {
  /**
   * ボットの一覧はシェルの読み込み結果で、サイドバーの更新のたびに
   * 中身が同じでも別の配列になる。吹き出しと同じ文脈に入れていると、
   * そのたびに全吹き出しを描き直す。使うのは編集欄だけなので、
   * 新しい一覧はそこにだけ届けばよい。
   */
  it("ボットの一覧が変わっても、吹き出しは描き直さず、編集欄には届く", async () => {
    const list = turns(5);
    server = installServer(list);
    const { user, setBots } = renderChat({
      conversationId: "c1",
      initialMessages: list,
    });
    await settle();
    await user.click((await screen.findAllByLabelText("編集して再送信"))[0]);
    const box = await screen.findByDisplayValue("質問1");
    renders.reset();

    setBots([
      {
        id: "bot-1",
        name: "翻訳係",
        icon: "🌐",
        model_id: TEST_MODEL.id,
        system_prompt: null,
        params_json: null,
        created_at: 0,
        updated_at: 0,
      } as BotRow,
    ]);

    expect(total(renders.assistant)).toBe(0);
    expect(total(renders.user)).toBe(0);

    // 新しい一覧が編集欄には届いている（候補に出る）
    box.focus();
    (box as HTMLTextAreaElement).setSelectionRange(0, 0);
    await user.keyboard("@");
    const panel = await screen.findByRole("listbox", { name: "宛先のボット" });
    expect(panel.textContent).toContain("翻訳係");
    expect(screen.getByText("答え1です。")).toBeInTheDocument();
  });
});

describe("描き直さなくても、操作は最新の状態で動く", () => {
  it("⚙で変えた値は、吹き出しの「再生成」にも効く", async () => {
    // 一覧は ⚙の変更では描き直されない。吹き出しの「再生成」が
    // 描いた時点の関数を握ったままだと、変える前の値で投げ直す
    server.on("/generate", () => new Promise<never>(() => {}));
    const { user } = renderChat({ conversationId: "c1", initialMessages: conversation });
    expect(await screen.findByText("二つ目の答え")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "生成パラメータ" }));
    await user.click(
      await screen.findByRole("button", { name: "Temperatureを手動設定" }),
    );
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "再生成" }));
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    const body = server.lastBody("/generate") as { params?: Record<string, unknown> };
    expect(body.params).toEqual({ temperature: 1 });
  });

  /**
   * 吹き出しが描画中に呼ぶ判定（画像の生成中か）は、元の値が変われば
   * 描き直しを起こさないといけない。「同一性を保つ」包みを同じように
   * かぶせると、選んでいるモデルを変えても見た目が古いまま残る。
   *
   * modelId を持たない古い行だけが、いま選んでいるモデルで判断される
   * （生成中の切り替えで見た目が変わらないことは chat-send が見ている）。
   */
  it("描画中に使う判定は、モデルを変えると吹き出しに届く", async () => {
    const IMAGE_MODEL = {
      ...TEST_MODEL,
      id: "test/image-model",
      name: "画像を出すモデル",
      outputModalities: ["image"],
    } as ModelInfo;
    const streaming = [
      msg("user", "猫の絵を描いて", { id: "u1" }),
      msg("assistant", "", { id: "a1", status: "streaming" }),
    ];
    server = installServer(streaming);
    const { user } = renderChat({
      conversationId: "c1",
      initialMessages: streaming,
      models: [TEST_MODEL, IMAGE_MODEL],
      initialModel: TEST_MODEL.id,
    });
    expect(await screen.findByText("猫の絵を描いて")).toBeInTheDocument();
    expect(screen.queryByText(/画像を生成中/)).toBeNull();

    await user.click(
      await screen.findByRole("button", { name: new RegExp(TEST_MODEL.name) }),
    );
    const picked = await screen.findAllByRole("button", {
      name: /画像を出すモデル/,
    });
    await user.click(picked[picked.length - 1]);

    expect(await screen.findByText(/画像を生成中/)).toBeInTheDocument();
  });
});

/**
 * 生成中の追跡（400ms ごとのポーリング）と、過去の発言の編集。
 *
 * どちらも変わるのは1行だけなのに、以前は会話の全吹き出しを描き直して
 * いた。ポーリングは本文が変わっていなくても新しい並びを作っていて、
 * 吹き出しにも行ごとの memo が無かったので、生成中は 0.4 秒ごとに
 * 会話の全部を描いていた。編集欄に1文字打つたびにも全部を描き直して
 * いた。見た目は変わらないので、数えないと気づけない。
 */
describe("変わった行だけを描き直す", () => {
  /** 10往復のあとに、生成中の応答が1つ。 */
  function streamingConversation() {
    return [
      ...turns(10),
      msg("user", "質問11", { id: "u11" }),
      msg("assistant", "書きかけの段落。", { id: "a11", status: "streaming" }),
    ];
  }

  /** サーバー側の生成中の本文。書き換えると次のポーリングで届く。 */
  function serveStreaming(list: ReturnType<typeof streamingConversation>) {
    server = installServer(list);
    const state = { content: "書きかけの段落。" };
    /*
     * 使用量と出典も毎回同じ中身で返す。届くたびに別の物として組み立て
     * られるので、同一性で比べていると「変わった」ことになってしまう
     */
    server.on("/messages/", () => ({
      content: state.content,
      reasoning: null,
      status: "streaming",
      error: null,
      usage: { cost: 0.01 },
      citations: [{ url: "https://example.com/a", title: "出典" }],
    }));
    return state;
  }

  const polls = () => server.countOf("/messages/");

  it("本文が変わらないポーリングでは、どの吹き出しも描き直さない", async () => {
    const list = streamingConversation();
    serveStreaming(list);
    renderChat({ conversationId: "c1", initialMessages: list });
    await settle();
    // 追跡が始まっていて、最初の1回（全文が届く）は済んでいる
    await waitFor(() => expect(polls()).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
    renders.reset();
    const from = polls();

    await waitFor(() => expect(polls()).toBeGreaterThanOrEqual(from + 4), {
      timeout: 5000,
    });

    expect(total(renders.assistant)).toBe(0);
    expect(total(renders.user)).toBe(0);
    // 一覧が消えたから 0 なのではないこと。生成中の行も前の行も出ている
    // （生成中の本文は1語ずつ包まれるので、要素ではなく文字で見る）
    expect(document.body.textContent).toContain("書きかけの段落。");
    expect(screen.getByText("答え1です。")).toBeInTheDocument();
    expect(screen.getByText("質問11")).toBeInTheDocument();
  }, 15000);

  it("本文が伸びたら、生成中の吹き出しだけを描き直す", async () => {
    const list = streamingConversation();
    const state = serveStreaming(list);
    renderChat({ conversationId: "c1", initialMessages: list });
    await settle();
    await waitFor(() => expect(polls()).toBeGreaterThanOrEqual(1), {
      timeout: 3000,
    });
    renders.reset();

    state.content = "書きかけの段落。\n\n続きが届きました。";
    // 伸びたぶんが画面に出る（描き直しを止めすぎていないこと）。
    // 流れてくる語は1語ずつ包まれるので、要素ではなく文字で見る
    await waitFor(
      () => expect(document.body.textContent).toContain("続きが届きました。"),
      { timeout: 3000 },
    );

    expect([...renders.assistant.keys()]).toEqual(["a11"]);
    expect(total(renders.user)).toBe(0);
    expect(screen.getByText("答え10です。")).toBeInTheDocument();
    // 生成中の応答は塊に分けて描いている（下の「確定済みは分けない」の
    // 見張りが、分けを数え損ねて素通りしていないことの確かめも兼ねる）
    expect(renders.split.some((s) => s.includes("続きが届きました。"))).toBe(
      true,
    );
  }, 15000);

  it("過去の発言を編集している間、ほかの吹き出しは描き直さない", async () => {
    const list = turns(10);
    server = installServer(list);
    const { user } = renderChat({ conversationId: "c1", initialMessages: list });
    await settle();
    await user.click((await screen.findAllByLabelText("編集して再送信"))[0]);
    const box = await screen.findByDisplayValue("質問1");
    renders.reset();

    await user.type(box, "あいうえおかきくけこ");
    expect(box).toHaveValue("質問1あいうえおかきくけこ");

    expect(total(renders.assistant)).toBe(0);
    // 描き直すのは編集している行だけ
    expect([...renders.user.keys()]).toEqual(["u1"]);
    expect(screen.getByText("質問2")).toBeInTheDocument();
    expect(screen.getByText("答え1です。")).toBeInTheDocument();
  }, 15000);
});

/**
 * 「変わっていなければ描き直さない」の裏側。本文が同じでも、状態・
 * 使用量が変わったポーリングは画面に届かないといけない。比べる項目を
 * 1つ落とすと、その変化だけが黙って捨てられる。
 *
 * 終わったあとの取り直し（/path）は返さずに止めておく。返すとそちらが
 * 確定した行で上書きし、ポーリングで捨てた変化を隠してしまう。
 */
describe("本文が同じでも、変わったものは届く", () => {
  function serve(remote: () => Record<string, unknown>) {
    const list = [
      msg("user", "質問", { id: "u1" }),
      msg("assistant", "途中まで。", { id: "a1", status: "streaming" }),
    ];
    server = installServer(list);
    server.on("/path", () => new Promise<never>(() => {}));
    server.on("/messages/", () => ({
      content: "途中まで。",
      reasoning: null,
      status: "streaming",
      error: null,
      usage: null,
      citations: null,
      ...remote(),
    }));
    renderChat({ conversationId: "c1", initialMessages: list });
  }

  it("生成中に額が変わると、吹き出しの額も変わる", async () => {
    const state = { cost: 0.01 };
    serve(() => ({ usage: { cost: state.cost } }));
    // 150円/ドル（足場の既定）。額は吹き出しと上の副題の両方に出る
    expect(
      await screen.findAllByText("¥1.50", {}, { timeout: 3000 }),
    ).toHaveLength(2);
    state.cost = 0.02;
    expect(
      await screen.findAllByText("¥3.00", {}, { timeout: 3000 }),
    ).toHaveLength(2);
  }, 10000);

  it("生成中に出典が増えると、吹き出しの出典も増える", async () => {
    const state = { hosts: ["first.example"] };
    serve(() => ({
      citations: state.hosts.map((h) => ({ url: `https://${h}/`, title: h })),
    }));
    expect(
      await screen.findByText("first.example", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    state.hosts = ["first.example", "second.example"];
    expect(
      await screen.findByText("second.example", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  }, 10000);

  it("本文がそのまま失敗に変わっても、失敗の帯が出る", async () => {
    const state = { failed: false };
    serve(() =>
      // 理由は付けない（状態だけが変わる。理由の違いで気づかせない）
      state.failed ? { status: "error" } : {},
    );
    await waitFor(() => expect(server.countOf("/messages/")).toBeGreaterThanOrEqual(1), {
      timeout: 3000,
    });
    state.failed = true;
    expect(
      await screen.findByText("応答を取得できませんでした", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("生成に失敗しました")).toBeInTheDocument();
  }, 10000);
});

/**
 * 確定した応答の描き方。
 *
 * 塊に分けて描くのは、生成中に伸びる末尾だけを解析し直すため。確定済みの
 * 応答を分けても得るものは無く、塊ごとに ReactMarkdown が解析の道具を
 * 組み直すぶん重くなる（2.6KB の応答が 81 塊に分かれ、1つで描くときの
 * 約3.6倍かかっていた）。会話を開いたときに並ぶのはほとんどがこれ。
 */
describe("確定した応答は、ひとつの Markdown として描く", () => {
  it("開いたときに確定している応答は、塊に分けない", async () => {
    const list = turns(3);
    server = installServer(list);
    renderChat({ conversationId: "c1", initialMessages: list });
    await settle();

    // 描かれていること（分けなかったのは、描いていないからではない）
    expect(screen.getByText("答え1です。")).toBeInTheDocument();
    expect(screen.getByText("続きの段落3。")).toBeInTheDocument();
    expect(renders.split.filter((s) => s.includes("答え"))).toEqual([]);
  });

  /**
   * この画面で流れてきた応答は、終わっても塊のまま描く。終わった
   * ところで1つの Markdown に描き方を変えると、React はそこを作り直し、
   * 出来上がった図や並べ替えた表が元に戻る（監査 E-7）。
   */
  it("流れてきた応答は、終わっても作り直さない", async () => {
    const TABLE = `表です。

| 名前 | 数 |
|---|---|
| い | 2 |
| あ | 1 |
`;
    const list = [
      msg("user", "表をください", { id: "u1" }),
      msg("assistant", "", { id: "a1", status: "streaming" }),
    ];
    server = installServer(list);
    const state = { status: "streaming" };
    server.on("/messages/", () => ({
      content: TABLE,
      reasoning: null,
      status: state.status,
      error: null,
      usage: null,
      citations: null,
    }));
    const { user } = renderChat({ conversationId: "c1", initialMessages: list });

    await waitFor(() => expect(document.querySelector("table")).toBeTruthy(), {
      timeout: 3000,
    });
    await user.click(screen.getAllByRole("columnheader")[0]);
    const rows = () =>
      [...document.querySelectorAll("tbody tr")].map((r) => r.textContent);
    expect(rows()).toEqual(["あ1", "い2"]);
    const before = document.querySelector("table");
    // 塊として描いている（このあと描き方が変われば作り直しになる）
    expect(renders.split.some((s) => s.includes("| 名前 |"))).toBe(true);

    // 確定させる。終わったあとの取り直し（/path）も確定した行を返す
    server.messages[1] = { ...server.messages[1], content: TABLE, status: undefined };
    state.status = "done";
    expect(
      await screen.findByRole("button", { name: "再生成" }, { timeout: 3000 }),
    ).toBeInTheDocument();

    expect(document.querySelector("table")).toBe(before);
    expect(rows()).toEqual(["あ1", "い2"]);
  }, 15000);
});
