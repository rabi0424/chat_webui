import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  installServer,
  renderChat,
  type ServerStub,
} from "./helpers/chat-harness";

/**
 * 停止。
 *
 * 送信した直後は、応答の行にサーバーのIDがまだ付いていない（保存の返事を
 * 待っている最中）。以前はここで黙って何もしなかったので、**停止ボタンを
 * 押しても無反応**に見えた。押した意思を覚えておき、IDが付いた時点で送る。
 */
let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

describe("生成中の停止", () => {
  /** 生成を始めて、保存の返事を保留にしたところで止める。 */
  async function startAndHold() {
    let release: ((v: unknown) => void) | null = null;
    server.on("/generate", () => new Promise((r) => (release = r)));
    const { user } = renderChat({});
    await user.type(screen.getByRole("textbox"), "こんにちは");
    await user.click(screen.getByLabelText("送信"));
    await waitFor(() => expect(screen.getByLabelText("停止")).toBeTruthy());
    return { user, release: () => release?.({ userMessageId: "u9", assistantMessageId: "a9" }) };
  }

  it("IDが付くまでは、まだ送らない", async () => {
    const { user } = await startAndHold();
    await user.click(screen.getByLabelText("停止"));
    expect(server.countOf("/stop")).toBe(0);
    expect(document.body.textContent).toContain("停止しています");
  });

  /** これが直したかったところ。 */
  it("IDを待っているあいだに押しても、届いた時点で送る", async () => {
    const { user, release } = await startAndHold();

    // まだ保存の返事が来ていない。以前はここで無反応だった
    await user.click(screen.getByLabelText("停止"));
    expect(server.countOf("/stop")).toBe(0);

    release();
    await waitFor(() => expect(server.countOf("/stop")).toBe(1));
    expect(server.lastBody("/stop")).toMatchObject({ messageId: "a9" });
  });

  it("押していなければ、勝手に止めない", async () => {
    const { release } = await startAndHold();
    release();
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(server.countOf("/stop")).toBe(0);
  });

  /**
   * 押した意思を次へ持ち越さない。
   *
   * 覚えたまま消し忘れると、止めた直後に始めた**別の生成がその場で
   * 止まる**——送ったのに何も返ってこない、という形になる。
   */
  it("止めたあと、次の生成は勝手に止まらない", async () => {
    const { user, release } = await startAndHold();
    await user.click(screen.getByLabelText("停止"));
    release();
    await waitFor(() => expect(server.countOf("/stop")).toBe(1));

    // 2回目を送る
    let release2: ((v: unknown) => void) | null = null;
    server.on("/generate", () => new Promise((r) => (release2 = r)));
    await user.type(screen.getByRole("textbox"), "もう一度");
    await user.click(screen.getByLabelText("送信"));
    release2?.({ userMessageId: "u10", assistantMessageId: "a10" });

    await waitFor(() => expect(server.countOf("/generate")).toBe(2));
    await new Promise((r) => setTimeout(r, 30));
    // 1回目のぶんだけ。2回目は止めていない
    expect(server.countOf("/stop")).toBe(1);
  });

  /**
   * 送信そのものが失敗すると、IDは永久に来ない——覚えた意思を消す機会が
   * 無いまま残る。次に送ったものが、その場で止まってしまう。
   */
  it("生成が失敗して意思が残っても、次の生成は止まらない", async () => {
    let fail: ((v: unknown) => void) | null = null;
    server.on("/generate", () => new Promise((_, r) => (fail = r)));

    const { user } = renderChat({});
    await user.type(screen.getByRole("textbox"), "こんにちは");
    await user.click(screen.getByLabelText("送信"));
    await waitFor(() => expect(screen.getByLabelText("停止")).toBeTruthy());
    await user.click(screen.getByLabelText("停止"));

    // 送信が失敗する。IDは来ないので、覚えた意思は残ったまま
    fail?.(new Error("切れました"));
    await waitFor(() => expect(screen.getByLabelText("送信")).toBeTruthy());
    expect(server.countOf("/stop")).toBe(0);

    // 2回目を送る
    let release2: ((v: unknown) => void) | null = null;
    server.on("/generate", () => new Promise((r) => (release2 = r)));
    await user.type(screen.getByRole("textbox"), "もう一度");
    await user.click(screen.getByLabelText("送信"));
    release2?.({ userMessageId: "u10", assistantMessageId: "a10" });

    await waitFor(() => expect(server.countOf("/generate")).toBe(2));
    await new Promise((r) => setTimeout(r, 30));
    // 前に押した停止に巻き込まれない
    expect(server.countOf("/stop")).toBe(0);
  });

  it("止め損ねたら、そう伝える", async () => {
    const { user, release } = await startAndHold();
    server.fail("/stop", 500);
    await user.click(screen.getByLabelText("停止"));
    release();
    await waitFor(() =>
      expect(document.body.textContent).toContain("停止できませんでした"),
    );
  });
});
