import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { installServer, msg, renderChat, type ServerStub } from "./helpers/chat-harness";

/**
 * 編集フォームの「送信」。コンポーザーの送信ボタンは aria-label で
 * 同じ名前を持つので、文字として「送信」を出しているほうを選ぶ。
 */
function submitEditButton(): HTMLElement {
  const found = screen
    .getAllByRole("button", { name: "送信" })
    .filter((b) => b.textContent?.trim() === "送信");
  expect(found).toHaveLength(1);
  return found[0];
}

/**
 * 編集して再送信。
 *
 * 「その発言を書き換えて、そこから分岐を作る」操作。編集した発言より
 * 後ろは送らず、親は編集対象のひとつ手前になる——ここを取り違えると
 * 会話の木が繋がらなくなる（監査 D-9）。
 */
let server: ServerStub;
const conversation = () => [
  msg("user", "最初の質問", { id: "u1" }),
  msg("assistant", "最初の応答", { id: "a1" }),
  msg("user", "2つ目の質問", { id: "u2" }),
  msg("assistant", "2つ目の応答", { id: "a2" }),
];

beforeEach(() => {
  server = installServer(conversation());
  localStorage.clear();
});

describe("編集して再送信", () => {
  it("編集を始めると、その本文が入力欄に入る", async () => {
    const { user } = renderChat({ initialMessages: conversation() });
    const buttons = await screen.findAllByLabelText("編集して再送信");
    await user.click(buttons[0]); // 最初のユーザー発言
    const box = await screen.findByDisplayValue("最初の質問");
    expect(box).toBeTruthy();
  });

  it("書き換えて送ると、編集した本文が送られる", async () => {
    const { user } = renderChat({ initialMessages: conversation() });
    await user.click((await screen.findAllByLabelText("編集して再送信"))[0]);
    const box = await screen.findByDisplayValue("最初の質問");
    await user.clear(box);
    await user.type(box, "書き換えた質問");
    await user.click(submitEditButton());

    await waitFor(() => {
      const body = server.lastBody("/generate") as { userContent: string };
      expect(body.userContent).toBe("書き換えた質問");
    });
  });

  it("編集した発言の親は、そのひとつ手前になる", async () => {
    const { user } = renderChat({ initialMessages: conversation() });
    // 2つ目のユーザー発言を編集する
    await user.click((await screen.findAllByLabelText("編集して再送信"))[1]);
    const box = await screen.findByDisplayValue("2つ目の質問");
    await user.clear(box);
    await user.type(box, "別の2つ目");
    await user.click(submitEditButton());

    await waitFor(() => {
      const body = server.lastBody("/generate") as { parentId: string };
      // u2 の手前は a1。ここが u2 や null になると木が壊れる
      expect(body.parentId).toBe("a1");
    });
  });

  it("編集した発言より後ろは、モデルへ送らない", async () => {
    const { user } = renderChat({ initialMessages: conversation() });
    await user.click((await screen.findAllByLabelText("編集して再送信"))[0]);
    const box = await screen.findByDisplayValue("最初の質問");
    await user.clear(box);
    await user.type(box, "やり直し");
    await user.click(submitEditButton());

    await waitFor(() => {
      const body = server.lastBody("/generate") as {
        messages: { content: string }[];
      };
      const sent = body.messages.map((m) => m.content);
      expect(sent).toContain("やり直し");
      // 分岐前の続き（2つ目以降）は文脈に含めない
      expect(sent).not.toContain("2つ目の質問");
      expect(sent).not.toContain("2つ目の応答");
    });
  });

  it("編集をやめると元の表示に戻る", async () => {
    const { user } = renderChat({ initialMessages: conversation() });
    await user.click((await screen.findAllByLabelText("編集して再送信"))[0]);
    await screen.findByDisplayValue("最初の質問");
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    await waitFor(() => {
      expect(screen.queryByDisplayValue("最初の質問")).toBeNull();
      expect(screen.getByText("最初の質問")).toBeTruthy();
    });
    expect(server.calls.some((c) => c.path.includes("/generate"))).toBe(false);
  });
});

/**
 * 編集の「保存」。
 *
 * 書き直しと生成は必ずしも同時ではない——文面だけ整えておいて、モデルや
 * パラメータを選んでから送りたいことがある。生成の入口を通すと必ず1本
 * 走って課金されるので、保存だけの入口を別に持つ。
 */
describe("編集して保存（送らない）", () => {
  const saveButton = () => screen.getByRole("button", { name: "保存" });

  async function editFirstAndSave(text: string) {
    const { user } = renderChat({
      conversationId: "conv-1",
      initialMessages: conversation(),
    });
    const buttons = await screen.findAllByLabelText("編集して再送信");
    await user.click(buttons[0]);
    const box = await screen.findByDisplayValue("最初の質問");
    await user.clear(box);
    await user.type(box, text);
    await user.click(saveButton());
    return user;
  }

  it("生成せずに、書き換えた発言だけを保存する", async () => {
    await editFirstAndSave("書き直した質問");

    await waitFor(() => {
      expect(server.countOf("/api/conversations/conv-1/messages")).toBe(1);
    });
    expect(server.lastBody("/api/conversations/conv-1/messages")).toEqual({
      parentId: null,
      content: "書き直した質問",
      attachmentIds: [],
    });
    // ここが肝。生成の入口は叩かない（＝課金しない）
    expect(server.countOf("/generate")).toBe(0);
  });

  it("保存した枝を出すために、パスを取り直す", async () => {
    // 兄弟の番号（1/2 のような表示）はサーバーが持つ木からしか作れない
    await editFirstAndSave("書き直した質問");
    await waitFor(() => {
      expect(server.countOf("/path")).toBeGreaterThan(0);
    });
  });

  it("保存すると編集欄は閉じる", async () => {
    await editFirstAndSave("書き直した質問");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    });
  });
});
