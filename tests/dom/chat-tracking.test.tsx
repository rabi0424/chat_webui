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
