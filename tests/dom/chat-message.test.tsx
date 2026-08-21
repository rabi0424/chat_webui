import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { installServer, msg, renderChat, type ServerStub } from "./helpers/chat-harness";

/**
 * 吹き出しそのものの見せ方。
 *
 * 「末尾かどうか」と「生成中かどうか」で出し分けが変わる。どちらも
 * 一覧の外（Chat 本体）から渡される値なので、渡し忘れても型は通り、
 * 画面だけが静かに変わる。ここで押さえる。
 */
let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

describe("末尾のメッセージ", () => {
  it("失敗の再試行は、最後の1件にだけ出る", () => {
    renderChat({
      initialMessages: [
        msg("user", "1回目の質問", { id: "u1" }),
        msg("assistant", "", {
          id: "a1",
          status: "error",
          error: "前に失敗したほう",
        }),
        msg("user", "2回目の質問", { id: "u2" }),
        msg("assistant", "", {
          id: "a2",
          status: "error",
          error: "最後に失敗したほう",
        }),
      ],
    });
    // どちらの失敗も本文は出る
    expect(screen.getByText("前に失敗したほう")).toBeTruthy();
    expect(screen.getByText("最後に失敗したほう")).toBeTruthy();
    // やり直せるのは最後の1件だけ
    expect(screen.getAllByRole("button", { name: "再試行" })).toHaveLength(1);
  });
});

describe("生成中の吹き出し", () => {
  /** /generate を宙吊りにして、生成中のまま止める。 */
  function hangGeneration() {
    server.on("/generate", () => new Promise<never>(() => {}));
  }

  it("生成中は、編集・分岐・削除の入口を出さない", async () => {
    const { user } = renderChat({
      initialMessages: [
        msg("user", "前の質問", { id: "u1" }),
        msg("assistant", "前の答え", { id: "a1" }),
      ],
    });
    // 生成していないあいだは出ている
    expect(screen.getAllByLabelText("編集して再送信").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("削除").length).toBeGreaterThan(0);

    hangGeneration();
    await user.click(screen.getByRole("button", { name: "↻ 再生成" }));

    // 木が動いている最中なので、木を変える操作は伏せる
    await waitFor(() =>
      expect(screen.queryByLabelText("編集して再送信")).toBeNull(),
    );
    expect(screen.queryByLabelText("削除")).toBeNull();
    expect(screen.queryByTitle(/ここから分岐/)).toBeNull();
  });
});
