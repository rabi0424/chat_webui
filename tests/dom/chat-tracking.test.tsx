import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { installServer, renderChat, type ServerStub } from "./helpers/chat-harness";

/**
 * 生成の追跡。
 *
 * 生成はサーバー（Durable Object）で進み、この画面はポーリングで
 * 追いかけるだけ。「途中経過が出るか」「いつ追うのをやめるか」が
 * 崩れると、生成中のまま固まったり、消えた会話を永久に叩き続けたりする。
 */
let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

/** 送信して、生成中の状態にする。 */
async function send(user: ReturnType<typeof renderChat>["user"], text: string) {
  await user.type(await screen.findByRole("textbox"), text);
  await user.keyboard("{Enter}");
}

describe("差分で受け取る", () => {
  /*
   * 生成中の追跡は 400ms ごとに走る。応答の全文を毎回運んでいたので、
   * 長い応答ほど1回が重くなっていた（§3.3）。手元にある長さを伝えて、
   * その先だけを受け取る。
   *
   * **確定まで見てはいけない。** 確定した応答は必ず全文で返る（要約に
   * 置き換わることがあるため）ので、途中の継ぎ足しが壊れていても最後の
   * 1回で正しい本文に上書きされ、検査をすり抜ける。生成中のまま見る。
   */
  const WHOLE = "むかしむかしあるところにおじいさんとおばあさんがいました";

  function streaming(contentAt: (turn: number) => string) {
    server.on("/generate", () => ({
      userMessageId: "u1",
      assistantMessageId: "a1",
    }));
    server.on("/path", () => ({
      messages: [
        { id: "u1", role: "user", content: "質問", createdAt: 1 },
        { id: "a1", role: "assistant", content: "", createdAt: 2 },
      ],
    }));
    let turn = 0;
    server.on("/messages/", () => ({
      content: contentAt(++turn),
      reasoning: null,
      // 生成中のまま。確定させると全文が返り、継ぎ足しの誤りが隠れる
      status: "streaming",
      error: null,
      usage: null,
      citations: null,
    }));
  }

  it("伸びていく本文を継ぎ足して、全体を表示する", async () => {
    streaming((turn) => WHOLE.slice(0, Math.min(turn * 10, WHOLE.length)));
    const { user } = renderChat({});
    await send(user, "質問");

    // 差分だけを表示していると、画面に出るのは最後の断片だけになる
    await waitFor(
      () => expect(document.body.textContent).toContain(WHOLE),
      { timeout: 5000 },
    );

    // 手元の長さを伝えている（伝えなければ毎回全文が返り、差分は効かない）
    const polls = server.calls.filter((c) => c.path.includes("/messages/"));
    expect(polls[0].path).toContain("since=0");
    const asked = polls
      .map((c) => Number(new URL(c.path, "https://x").searchParams.get("since")))
      .filter((n) => n > 0);
    expect(asked.length).toBeGreaterThan(0);
  });

  it("本文が縮んだら、継ぎ足さずに取り直す", async () => {
    /*
     * 生成中でも本文が置き換わることがある（取り込んだ画像のURLの
     * 差し替えなど）。手元より短くなったのに黙って継ぎ足すと、消えた
     * はずの古い末尾が画面に残り続ける。
     */
    const LONG = "取り込み前の長い本文がここにあります";
    const SHORT = "短い本文";
    streaming((turn) => (turn <= 2 ? LONG : SHORT));

    const { user } = renderChat({});
    await send(user, "質問");

    await waitFor(
      () => expect(document.body.textContent).toContain(LONG),
      { timeout: 5000 },
    );
    await waitFor(
      () => expect(document.body.textContent).not.toContain(LONG),
      { timeout: 5000 },
    );
    expect(document.body.textContent).toContain(SHORT);
  });
});

describe("途中経過を追う", () => {
  it("生成中の本文が出て、完了で最終的な本文に変わる", async () => {
    // 生成を始めた時点では「生成中」の空の応答が積まれる
    server.on("/generate", () => ({
      userMessageId: "u1",
      assistantMessageId: "a1",
    }));
    server.on("/path", () => ({
      messages: [
        { id: "u1", role: "user", content: "質問", createdAt: 1 },
        { id: "a1", role: "assistant", content: "完成した応答", createdAt: 2 },
      ],
    }));

    let turn = 0;
    server.on("/messages/", () => {
      turn++;
      // 1回目は途中まで、2回目以降は完了
      return turn === 1
        ? {
            content: "書きかけ",
            reasoning: null,
            status: "streaming",
            error: null,
            usage: null,
            citations: null,
          }
        : {
            content: "完成した応答",
            reasoning: null,
            status: "done",
            error: null,
            usage: null,
            citations: null,
          };
    });

    const { user } = renderChat({});
    await send(user, "質問");

    /*
     * 途中経過が画面に出る（ここが出ないと生成中に何も見えない）。
     * ストリーミング中の本文は少しずつ現す都合で語ごとに要素が分かれる
     * ため、要素単位ではなく画面全体の文字で見る。
     */
    await waitFor(() =>
      expect(document.body.textContent).toContain("書きかけ"),
    );
    // 完了すると最終的な本文になる
    await waitFor(() =>
      expect(document.body.textContent).toContain("完成した応答"),
    );
    expect(server.countOf("/messages/")).toBeGreaterThan(1);
  });
});

describe("追うのをやめる条件", () => {
  it("会話が消えていたら（404）、叩き続けない", async () => {
    server.on("/generate", () => ({
      userMessageId: "u1",
      assistantMessageId: "a1",
    }));
    server.fail("/messages/", 404);

    const { user } = renderChat({});
    await send(user, "質問");

    await waitFor(() => expect(server.countOf("/messages/")).toBeGreaterThan(0));
    const afterStop = server.countOf("/messages/");
    // ポーリング間隔（400ms）を何回か跨いでも増えない
    await new Promise((r) => setTimeout(r, 1400));
    expect(server.countOf("/messages/")).toBe(afterStop);
  });

  it("一過性の失敗（500）では追うのをやめない", async () => {
    server.on("/generate", () => ({
      userMessageId: "u1",
      assistantMessageId: "a1",
    }));
    server.fail("/messages/", 500);

    const { user } = renderChat({});
    await send(user, "質問");

    await waitFor(() => expect(server.countOf("/messages/")).toBeGreaterThan(0));
    const first = server.countOf("/messages/");
    // 待てば直るかもしれないので、間を置いて叩き直す
    await waitFor(
      () => expect(server.countOf("/messages/")).toBeGreaterThan(first),
      { timeout: 3000 },
    );
  });
});
