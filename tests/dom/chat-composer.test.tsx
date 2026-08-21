import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { installServer, msg, renderChat, type ServerStub } from "./helpers/chat-harness";

/**
 * 入力欄まわり。
 *
 * 送信そのものは chat-send が見るので、ここは「押せる／押せない」と
 * 「送信と停止の入れ替わり」、そして添付の出し入れを押さえる。
 * どれも入力欄が Chat 本体から受け取る値で決まるので、渡し忘れても
 * 型は通り、画面だけが静かに変わる。
 */
// 画像の縮小はブラウザの機能（canvas）に依るので、テストでは素通しする
vi.mock("../../app/lib/image", async (orig) => {
  const actual = await orig<typeof import("../../app/lib/image")>();
  return { ...actual, prepareImage: async (f: File) => f };
});

let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

const png = (name: string) =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

describe("送信ボタン", () => {
  it("何も書いていなければ押せない", async () => {
    const { user } = renderChat({});
    const send = screen.getByLabelText("送信") as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    await user.type(screen.getByRole("textbox"), "こんにちは");
    expect(send.disabled).toBe(false);
  });

  it("生成中は停止に入れ替わる", async () => {
    server.on("/generate", () => new Promise<never>(() => {}));
    const { user } = renderChat({
      initialMessages: [
        msg("user", "前の質問", { id: "u1" }),
        msg("assistant", "前の答え", { id: "a1" }),
      ],
    });
    expect(screen.queryByLabelText("停止")).toBeNull();

    await user.click(screen.getByRole("button", { name: "↻ 再生成" }));
    await waitFor(() => expect(screen.getByLabelText("停止")).toBeTruthy());
    expect(screen.queryByLabelText("送信")).toBeNull();
  });
});

describe("入力欄の添付", () => {
  /** 添付の入力欄は hidden なので、直接 change を起こす。 */
  function pickFile(container: HTMLElement, file: File) {
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
  }

  it("選んだ画像が入力欄に並び、×で取り消せる", async () => {
    const { container, user } = renderChat({});
    pickFile(container, png("ねこ.png"));

    const thumb = await screen.findByAltText("ねこ.png");
    expect(thumb).toBeTruthy();

    await user.click(screen.getByLabelText("添付を削除"));
    await waitFor(() => expect(screen.queryByAltText("ねこ.png")).toBeNull());
  });

  it("画像だけなら本文が空でも送れる", async () => {
    const { container } = renderChat({});
    pickFile(container, png("ねこ.png"));

    await waitFor(() =>
      expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });
});
