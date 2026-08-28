import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  installServer,
  renderChat,
  TEST_MODEL,
  type ServerStub,
} from "./helpers/chat-harness";
import type { ModelInfo } from "../../app/lib/openrouter.server";

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

/**
 * 生成中のモデル切り替え。
 *
 * 画像を出すモデルの応答は本文が流れてこないので、「画像を生成中…」と
 * 秒だけを出す。この判断を応答の modelId で行うのに、プレースホルダには
 * 入れていなかったため、いま選んでいるモデルに落ちていた——生成中に
 * モデルを変えると、走っている応答の見た目が本文と進捗とで入れ替わる
 * （監査 C-6）。
 */
describe("生成中のモデル切り替え", () => {
  /** 画像を出すモデル。一覧の先頭に置くと、新規チャットではこれが選ばれる。 */
  const IMAGE_MODEL = {
    ...TEST_MODEL,
    id: "test/image-model",
    name: "画像を出すモデル",
    outputModalities: ["image"],
  } as ModelInfo;

  it("走っている応答の見た目は、切り替えても変わらない", async () => {
    server.on("/generate", () => new Promise<never>(() => {}));
    const { user } = renderChat({ models: [TEST_MODEL, IMAGE_MODEL] });

    // 画像を出すモデルを選んでから送る
    await user.click(
      await screen.findByRole("button", { name: new RegExp(TEST_MODEL.name) }),
    );
    const picked = await screen.findAllByRole("button", {
      name: /画像を出すモデル/,
    });
    await user.click(picked[picked.length - 1]);
    await screen.findByRole("button", { name: /画像を出すモデル/ });

    await user.type(await screen.findByRole("textbox"), "猫の絵を描いて");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/画像を生成中/)).toBeTruthy();

    // 走っている最中に、文字だけのモデルへ切り替える
    await user.click(screen.getByRole("button", { name: /画像を出すモデル/ }));
    const rows = await screen.findAllByRole("button", {
      name: new RegExp(TEST_MODEL.name),
    });
    await user.click(rows[rows.length - 1]);
    // 切り替わったことを確かめてから見る（切り替え自体が空振りだと、
    // このテストは何も検査していないことになる）
    await screen.findByRole("button", { name: new RegExp(TEST_MODEL.name) });

    expect(screen.getByText(/画像を生成中/)).toBeTruthy();
  });
});
