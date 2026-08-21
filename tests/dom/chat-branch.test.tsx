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
