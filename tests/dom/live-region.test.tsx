import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { LiveRegion } from "../../app/components/chat/LiveRegion";
import { installServer, renderChat, type ServerStub } from "./helpers/chat-harness";

/**
 * 生成の進み具合を読み上げへ流す領域（監査 F-20）。
 *
 * 画面では点滅するカーソルとエラーの帯で分かるが、どちらも見えている
 * 人にしか届かない。読み上げでは「送信した」あと何も起きないまま
 * 数十秒が過ぎ、終わったことも失敗したことも分からなかった。
 */

/** 読み上げ領域の中身を、並びのまま取り出す。 */
function slots(): string[] {
  return screen
    .getAllByRole("status")
    .map((el) => el.textContent ?? "");
}

describe("読み上げ領域そのもの", () => {
  /**
   * 支援技術は「もともとあった live region の中身が変わった」ことで
   * 読み上げる。文言と一緒に領域を出し入れすると、初回が読まれない
   * ことがあるので、何も言うことが無いあいだも置いておく。
   */
  it("何も起きていなくても、領域は先に置いてある", () => {
    render(<LiveRegion isStreaming={false} error={null} />);
    expect(slots()).toEqual(["", ""]);
  });

  /**
   * 同じ文言を続けて書くと textContent が変わらず、2度目は読まれない。
   * 交互に使い、書く前にもう片方を空にすることで、書き込み先は
   * いつも「空だったところ」になる。
   */
  it("同じ文言が続くときは、もう片方の領域へ書く", () => {
    const { rerender } = render(<LiveRegion isStreaming={false} error={null} />);

    rerender(<LiveRegion isStreaming={false} error="失敗" />);
    expect(slots()).toEqual(["生成に失敗しました: 失敗", ""]);

    // 帯を閉じる。ここでは何も言わない
    rerender(<LiveRegion isStreaming={false} error={null} />);
    expect(slots()).toEqual(["生成に失敗しました: 失敗", ""]);

    // 同じ失敗がもう一度。前と同じ場所へ書くと変化が無く、読まれない
    rerender(<LiveRegion isStreaming={false} error="失敗" />);
    expect(slots()).toEqual(["", "生成に失敗しました: 失敗"]);
  });
});

/**
 * ここから先は Chat との配線。上の2つは LiveRegion を直に動かしているので、
 * Chat から <LiveRegion> を消しても通ってしまう。画面に出ないものは
 * 外れても誰も気づかないため、繋がっていることを別に見張る。
 */
let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

describe("チャットからの読み上げ", () => {
  it("送信すると開始が、応答が届くと完了が読み上げに乗る", async () => {
    const { user } = renderChat({});
    await user.type(await screen.findByRole("textbox"), "こんにちは");
    await user.keyboard("{Enter}");

    // 応答は出ているのに、読み上げには何も乗らない——が元の姿
    expect(await screen.findByText("応答です")).toBeTruthy();
    await waitFor(() =>
      expect(slots().join("")).toContain("生成が完了しました"),
    );
  });

  it("生成中は「開始」が読み上げに乗っている", async () => {
    // 応答を返さないままにして、生成中で止める
    server.on("/generate", () => new Promise<never>(() => {}));

    const { user } = renderChat({});
    await user.type(await screen.findByRole("textbox"), "こんにちは");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(slots().join("")).toContain("生成を開始しました"),
    );
    // まだ終わっていないので、完了とは言わない
    expect(slots().join("")).not.toContain("生成が完了しました");
  });

  it("失敗したときは理由が読み上げに乗る", async () => {
    server.on(
      "/generate",
      () =>
        new Response(JSON.stringify({ error: "上限に達しました" }), {
          status: 402,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const { user } = renderChat({});
    await user.type(await screen.findByRole("textbox"), "こんにちは");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(slots().join("")).toContain("生成に失敗しました: 上限に達しました"),
    );
  });
});
