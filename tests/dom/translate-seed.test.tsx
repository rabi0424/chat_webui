/**
 * サーバーが出した「素のテキストの本文」が、本物の描画に**入れ替わる**か。
 *
 * この下書きは Safari に言語を数えさせるためだけのもの（PlainMessages）で、
 * 本物が描かれたら消えなければならない。消し忘れると、同じ本文が二度並ぶ
 * ——しかも片方は Markdown が効いていない素のテキストなので、記法が
 * そのまま見えている複製が画面に残る。
 *
 * 併せて、やり取りの範囲が会話の言語で宣言されているかも見る。画面まわりは
 * 日本語なので（`app/routes/shell.tsx` が `lang="ja"`）、ここで宣言し直さないと
 * 英語の会話の本文まで日本語だと言うことになる。
 */
import { describe, expect, it } from "vitest";
import { renderChat, msg } from "./helpers/chat-harness";

const EN =
  "The quick brown fox jumps over the lazy dog. This reply is long enough for the detector to judge it as English.";
const JA =
  "これは日本語の応答です。判定に足りるだけの長さがあり、ひらがなも漢字もカタカナも含んでいます。";

/** やり取りを包む要素（言語を宣言しているところ）。 */
function feed(view: ReturnType<typeof renderChat>): HTMLElement {
  const el = view.container.querySelector(".chat-text");
  if (!el) throw new Error("やり取りの範囲が見つからない");
  return el as HTMLElement;
}

describe("翻訳のための下書き", () => {
  it("本物が描かれたら、素のテキストの下書きは残らない", () => {
    const body = `**強調** を含む本文です。${EN}`;
    const view = renderChat({ initialMessages: [msg("assistant", body)] });

    // 本物が描かれている（記法が解釈されている）
    expect(view.container.querySelector("strong")).not.toBeNull();
    // 同じ本文が二度出ていない。素のテキストのままの `**強調**` が
    // 残っていれば、下書きが消えていない
    expect(view.container.textContent).not.toContain("**強調**");
    expect(
      view.container.querySelectorAll(".prose").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("やり取りの範囲を会話の言語で宣言する", () => {
    expect(feed(renderChat({ initialMessages: [msg("assistant", EN)] }))).toHaveAttribute(
      "lang",
      "en",
    );
    expect(feed(renderChat({ initialMessages: [msg("assistant", JA)] }))).toHaveAttribute(
      "lang",
      "ja",
    );
  });
});
