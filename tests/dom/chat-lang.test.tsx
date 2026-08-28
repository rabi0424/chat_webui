import { beforeEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderChat } from "./helpers/chat-harness";
import type { UiMessage } from "../../app/lib/types";

/**
 * 会話の言語を <html lang> に伝える配線。
 *
 * この画面はサーバーが器だけを返すので、読み込みが終わった時点で Safari が
 * 見られるのは <html lang="ja"> の宣言だけになる。英語の会話を開いても
 * 「日本語のページ」と判定され、翻訳が出てこない——本文はそのあと React が
 * 描くが、判定はもう済んでいる。
 *
 * 判定そのものは tests/content-language.test.ts で見る。ここでは
 * 「描いたあとに宣言が実際に書き換わるか」だけを見る（関数が正しくても
 * 呼ばれていなければ何も直らないので、両方が要る）。
 */

const EN =
  "The quick brown fox jumps over the lazy dog. This reply is long enough for the detector to call it English.";
const JA =
  "これは日本語の応答です。判定に足りるだけの長さがあり、ひらがなも漢字もカタカナも含んでいます。";

const conversation = (reply: string): UiMessage[] => [
  { id: "u1", role: "user", content: "hello" },
  { id: "a1", role: "assistant", content: reply },
];

beforeEach(() => {
  document.documentElement.lang = "ja";
});

describe("会話の言語を <html lang> に伝える", () => {
  it("英語の会話を開くと en になる", async () => {
    renderChat({ conversationId: "c1", initialMessages: conversation(EN) });
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
  });

  it("日本語の会話では ja のまま", async () => {
    const view = renderChat({
      conversationId: "c1",
      initialMessages: conversation(JA),
    });
    // 本文が描かれるまで待ってから見る（描く前の "ja" を見て通ってしまわないように）
    await waitFor(() => expect(view.getByText(JA)).toBeTruthy());
    expect(document.documentElement.lang).toBe("ja");
  });

  it("会話を離れると元に戻る", async () => {
    const view = renderChat({
      conversationId: "c1",
      initialMessages: conversation(EN),
    });
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    view.unmount();
    expect(document.documentElement.lang).toBe("ja");
  });

  it("判定できない短い会話では触らない", async () => {
    const view = renderChat({
      conversationId: "c1",
      initialMessages: [{ id: "u1", role: "user", content: "ok" }],
    });
    await waitFor(() => expect(view.getByText("ok")).toBeTruthy());
    expect(document.documentElement.lang).toBe("ja");
  });
});
