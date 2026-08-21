import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { installServer, renderChat, type ServerStub } from "./helpers/chat-harness";

/**
 * 送信。Chat のいちばん基本の流れで、ここが崩れると何も使えない。
 * 楽観表示（送った本文がその場で見える）と、サーバーへ渡る中身を見る。
 */
let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

describe("送信", () => {
  it("サーバーの応答を待たずに、送った本文が出る", async () => {
    // 生成の応答を返さないままにして「通信中」を作る。
    // ここで本文が見えなければ、楽観表示が効いていないということ
    server.on("/generate", () => new Promise<never>(() => {}));

    const { user } = renderChat({});
    await user.type(await screen.findByRole("textbox"), "こんにちは");
    await user.keyboard("{Enter}");

    expect(await screen.findByText("こんにちは")).toBeTruthy();
    // サーバーはまだ何も返していない
    expect(server.calls.some((c) => c.path.includes("/path"))).toBe(false);
  });

  it("応答が届くと画面に出る", async () => {
    const { user } = renderChat({});
    await user.type(await screen.findByRole("textbox"), "こんにちは");
    await user.keyboard("{Enter}");

    expect(await screen.findByText("こんにちは")).toBeTruthy();
    expect(await screen.findByText("応答です")).toBeTruthy();
  });

  it("本文と親をサーバーへ渡す", async () => {
    const { user } = renderChat({});
    await user.type(await screen.findByRole("textbox"), "質問です");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const body = server.lastBody("/generate") as {
        userContent: string;
        parentId: string | null;
      };
      expect(body.userContent).toBe("質問です");
      // 最初の発言なので親は無い
      expect(body.parentId).toBeNull();
    });
  });

  it("2通目は直前の応答にぶら下げる", async () => {
    const { user } = renderChat({});
    const box = await screen.findByRole("textbox");
    await user.type(box, "1通目");
    await user.keyboard("{Enter}");
    await screen.findByText("応答です");

    await user.type(box, "2通目");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const body = server.lastBody("/generate") as { parentId: string | null };
      // 直前の応答（サーバーが採番したID）が親になる
      expect(body.parentId).toBe(server.messages[1].id);
    });
  });

  it("空欄では送らない", async () => {
    const { user } = renderChat({});
    await user.click(await screen.findByRole("textbox"));
    await user.keyboard("{Enter}");
    expect(server.calls.some((c) => c.path.includes("/generate"))).toBe(false);
  });

  it("送信すると入力欄が空になる", async () => {
    const { user } = renderChat({});
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await user.type(box, "送る");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(box.value).toBe(""));
  });
});
