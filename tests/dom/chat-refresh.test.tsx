import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  installServer,
  pullToRefresh,
  renderChat,
  type ServerStub,
} from "./helpers/chat-harness";

/**
 * 送信中に横から表示が差し替わったときの守り（監査 D-6）。
 *
 * 送った直後は、保存が終わるまで自分の発言とプレースホルダがIDを持たずに
 * 並んでいる。この状態でサーバーの並びに置き換えると、それらが消えて、
 * あとから届いたIDが別のメッセージに付き、前の応答が上書きされて見える。
 */
let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

describe("送信中の取り直し", () => {
  it("保存前の発言が、サーバーの並びで消されない", async () => {
    // 生成の応答を保留したまま、取り直しだけを走らせる
    let release: (v: unknown) => void = () => {};
    server.on("/generate", () => new Promise((r) => (release = r)));
    // 取り直しは「まだその発言を知らない」サーバーの並びを返す
    server.on("/path", () => ({ messages: [] }));

    const { user } = renderChat({});
    await user.type(await screen.findByRole("textbox"), "保存前の発言");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("保存前の発言")).toBeTruthy();

    // 保存を待っているあいだに、引っぱって更新した
    pullToRefresh();
    await waitFor(() =>
      expect(server.calls.some((c) => c.path.includes("/path"))).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 50));

    // 消えていないこと（ここが D-6 の症状）
    expect(screen.getByText("保存前の発言")).toBeTruthy();

    release({ userMessageId: "u1", assistantMessageId: "a1" });
  });

  it("すべて保存済みなら、取り直しの結果を反映する", async () => {
    const { user } = renderChat({});
    await user.type(await screen.findByRole("textbox"), "ひとつ目");
    await user.keyboard("{Enter}");
    // 生成が終わり、IDが揃うまで待つ
    expect(await screen.findByText("応答です")).toBeTruthy();

    // 別の端末で会話が進んだ状況を返す
    server.on("/path", () => ({
      messages: [
        { id: "x1", role: "user", content: "別の端末の発言", createdAt: 1 },
      ],
    }));
    pullToRefresh();

    // 保存済みしか無いので、取り直した内容に置き換わる
    expect(await screen.findByText("別の端末の発言")).toBeTruthy();
  });
});
