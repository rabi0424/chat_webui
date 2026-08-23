import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  acceptConfirm,
  installServer,
  msg,
  renderChat,
  type ServerStub,
} from "./helpers/chat-harness";

/**
 * 分岐まわり。
 *
 * 「‹ ›」のページャで兄弟の応答を行き来する切替と、
 * 「⑂ ここから分岐」で独立した会話を作るフォークの2つがある。
 */
let server: ServerStub;
beforeEach(() => {
  localStorage.clear();
  acceptConfirm();
});

/** 同じ親に2つの応答がぶら下がっている状態。 */
const withSiblings = () => [
  msg("user", "質問", { id: "u1" }),
  msg("assistant", "応答A", {
    id: "a1",
    siblingIds: ["a1", "a2"],
    siblingIndex: 0,
  }),
];

describe("ブランチの切替", () => {
  it("兄弟があるとページャが出る", async () => {
    server = installServer(withSiblings());
    renderChat({ initialMessages: withSiblings() });
    expect(await screen.findByLabelText("次のブランチ")).toBeTruthy();
    expect(screen.getByLabelText("前のブランチ")).toBeTruthy();
  });

  it("兄弟が無ければページャは出ない", async () => {
    server = installServer();
    renderChat({
      initialMessages: [
        msg("user", "質問", { id: "u1" }),
        msg("assistant", "応答", { id: "a1" }),
      ],
    });
    await screen.findByText("応答");
    expect(screen.queryByLabelText("次のブランチ")).toBeNull();
  });

  it("次へ押すと、切替先をサーバーへ伝えて表示が入れ替わる", async () => {
    server = installServer([
      msg("user", "質問", { id: "u1" }),
      msg("assistant", "応答B", { id: "a2" }),
    ]);
    const { user } = renderChat({ initialMessages: withSiblings() });
    await user.click(await screen.findByLabelText("次のブランチ"));

    await waitFor(() => {
      const body = server.lastBody("/path") as { messageId: string };
      expect(body.messageId).toBe("a2");
    });
    // サーバーが返した並びに置き換わる
    expect(await screen.findByText("応答B")).toBeTruthy();
    expect(screen.queryByText("応答A")).toBeNull();
  });
});

describe("ここから分岐（フォーク）", () => {
  it("分岐を押すと、そのメッセージを指定して新しい会話を作る", async () => {
    server = installServer();
    const { user } = renderChat({
      initialMessages: [
        msg("user", "質問", { id: "u1" }),
        msg("assistant", "応答", { id: "a1" }),
      ],
    });
    const forks = await screen.findAllByTitle(
      "ここから分岐（独立した新しい会話を作成）",
    );
    await user.click(forks[0]);

    await waitFor(() => {
      const call = server.calls.find((c) => c.path.includes("/fork"));
      expect(call).toBeTruthy();
      expect((call!.body as { messageId: string }).messageId).toBe("u1");
    });
  });

  it("確認でやめたら作らない", async () => {
    acceptConfirm(false);
    server = installServer();
    const { user } = renderChat({
      initialMessages: [
        msg("user", "質問", { id: "u1" }),
        msg("assistant", "応答", { id: "a1" }),
      ],
    });
    const forks = await screen.findAllByTitle(
      "ここから分岐（独立した新しい会話を作成）",
    );
    await user.click(forks[0]);
    await waitFor(() =>
      expect(server.calls.some((c) => c.path.includes("/fork"))).toBe(false),
    );
  });
});

/**
 * 連打したときの順序。
 *
 * ページャを続けて押すと要求が並んで飛び、返る順は投げた順とは限らない。
 * 古いほうが後に返ると、押したのとは違う枝が最後に表示されて残る——
 * 画面と「いまどの枝を見ているか」がずれる。
 */
describe("切替の連打", () => {
  it("古い応答が後から返っても、最後に押した枝が残る", async () => {
    server = installServer(withSiblings());

    // 1回目の応答だけ遅らせる
    let releaseFirst: (() => void) | null = null;
    let nth = 0;
    server.on("/path", () => {
      nth++;
      const which = nth;
      const body = {
        messages: [
          msg("user", "質問", { id: "u1" }),
          msg("assistant", which === 1 ? "古い応答" : "新しい応答", {
            id: which === 1 ? "a1" : "a2",
          }),
        ],
      };
      if (which === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve(body);
        });
      }
      return body;
    });

    const { user } = renderChat({ initialMessages: withSiblings() });
    const next = await screen.findByLabelText("次のブランチ");

    await user.click(next); // 1回目（遅い）
    await user.click(next); // 2回目（速い）

    await waitFor(() =>
      expect(document.body.textContent).toContain("新しい応答"),
    );

    // ここで1回目がようやく返る
    releaseFirst?.();
    await new Promise((r) => setTimeout(r, 10));

    expect(document.body.textContent).toContain("新しい応答");
    expect(document.body.textContent).not.toContain("古い応答");
  });
})

/**
 * 生成中の枝の行き来。
 *
 * 生成はサーバーで走っていて、画面がどの枝を出しているかとは関係しない。
 * それでも閉じていたので、走っているあいだ（「成功するまで生成」では
 * 何分も）過去の応答を見比べることも、そこから枝を作ることもできなかった。
 */
describe("生成中の枝の行き来", () => {
  /** 生成を宙吊りにして、生成中のまま止める。 */
  function hangGeneration(stub: ServerStub) {
    stub.on("/generate", () => new Promise<never>(() => {}));
  }

  /**
   * 生成しても残る位置に兄弟を持たせる。再生成は末尾の応答を作り直す
   * ので、そこに兄弟を置いてもページャごと入れ替わってしまう。
   */
  const running = () => [
    msg("user", "最初の質問", {
      id: "u1",
      siblingIds: ["u1", "u1b"],
      siblingIndex: 0,
    }),
    msg("assistant", "最初の応答", { id: "a1" }),
    msg("user", "2つ目の質問", { id: "u2" }),
    msg("assistant", "2つ目の応答", { id: "a2" }),
  ];

  it("生成中でもページャを押せる", async () => {
    server = installServer(running());
    const { user } = renderChat({ initialMessages: running() });
    hangGeneration(server);
    await user.click(screen.getByRole("button", { name: "↻ 再生成" }));
    await waitFor(() => expect(screen.getByLabelText("停止")).toBeTruthy());

    const next = screen.getByLabelText("次のブランチ");
    expect(next.hasAttribute("disabled")).toBe(false);
    await user.click(next);
    await waitFor(() => {
      expect(server.lastBody("/path")).toEqual({ messageId: "u1b" });
    });
  });

  it("移った先の応答を、生成中の本文で書き換えない", async () => {
    server = installServer(running());
    // 生成中の行はサーバー側では進んでいる（本文が届く）
    server.on("/messages/", () => ({
      content: "生成中の本文です",
      reasoning: null,
      status: "streaming",
      error: null,
      usage: null,
      citations: null,
    }));
    // 切り替え先の枝（生成中の行は含まれない）
    server.on("/path", () => ({
      messages: [
        msg("user", "書き直した質問", {
          id: "u1b",
          siblingIds: ["u1", "u1b"],
          siblingIndex: 1,
        }),
        msg("assistant", "別の枝の応答", { id: "b1" }),
      ],
    }));

    const { user } = renderChat({ initialMessages: running() });
    server.on("/generate", () => ({
      userMessageId: null,
      assistantMessageId: "a3",
    }));
    await user.click(screen.getByRole("button", { name: "↻ 再生成" }));
    await waitFor(() => expect(screen.getByLabelText("停止")).toBeTruthy());

    await user.click(screen.getByLabelText("次のブランチ"));
    await screen.findByText("別の枝の応答");

    /*
     * 生成中の本文を「末尾のアシスタント」へ貼っていたので、枝を移ると
     * 無関係な応答が書き換わっていた。当てる先はIDで探す。
     * 追いかけること自体はやめない（生成はまだ走っている）。
     */
    await waitFor(() => {
      expect(server.countOf("/messages/a3")).toBeGreaterThan(1);
    });
    expect(screen.getByText("別の枝の応答")).toBeTruthy();
    expect(screen.queryByText("生成中の本文です")).toBeNull();
  });
});
