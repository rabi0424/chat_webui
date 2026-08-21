import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { installServer, renderChat, type ServerStub } from "./helpers/chat-harness";

/**
 * 上限に達したときの見え方。
 *
 * サーバーは 402 と理由を返す。画面側はそれを本文として出し、置いたまま
 * になった生成中のプレースホルダを片付けなければならない。残ると
 * 「動いていないのに動いているように見える」状態で止まる。
 */
let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

const BLOCKED =
  "今月の使用額が上限に達しました（約1200円 / 上限 500円）。設定画面から上限を変えるか、今月だけ一時解除できます。";

describe("上限で止められたとき", () => {
  /** 生成の入口が 402 を返すようにする。 */
  function blockGeneration() {
    server.on(
      "/generate",
      () =>
        new Response(JSON.stringify({ error: BLOCKED }), {
          status: 402,
          headers: { "Content-Type": "application/json" },
        }),
    );
  }

  it("理由がそのまま画面に出る", async () => {
    blockGeneration();
    const { user } = renderChat({});
    await user.type(screen.getByRole("textbox"), "こんにちは");
    await user.click(screen.getByLabelText("送信"));

    await waitFor(() =>
      expect(document.body.textContent).toContain("上限に達しました"),
    );
  });

  it("生成中のプレースホルダが残らない", async () => {
    blockGeneration();
    const { user } = renderChat({});
    await user.type(screen.getByRole("textbox"), "こんにちは");
    await user.click(screen.getByLabelText("送信"));

    await waitFor(() =>
      expect(document.body.textContent).toContain("上限に達しました"),
    );
    // 止まっているのに動いて見えるのが一番まずい。停止ボタンは消えている
    expect(screen.queryByLabelText("停止")).toBeNull();
    expect(screen.getByLabelText("送信")).toBeTruthy();
  });

  it("送った発言そのものは消えない", async () => {
    blockGeneration();
    const { user } = renderChat({});
    await user.type(screen.getByRole("textbox"), "消えたら困る文章");
    await user.click(screen.getByLabelText("送信"));

    await waitFor(() =>
      expect(document.body.textContent).toContain("上限に達しました"),
    );
    expect(screen.getByText("消えたら困る文章")).toBeTruthy();
  });

  it("上限に達していなければ、いつもどおり送れる", async () => {
    const { user } = renderChat({});
    await user.type(screen.getByRole("textbox"), "こんにちは");
    await user.click(screen.getByLabelText("送信"));
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    expect(document.body.textContent).not.toContain("上限に達しました");
  });
});
