import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * リトライ生成の「続けるかどうか」の配線。
 *
 * 打ち切りの理由はローカル変数（stopped / rateLimitExhausted /
 * budgetStopped）に散っていて、続行判定（moreAttempts）への追記を
 * 1つ忘れても画面には何も出ない。実際に budgetStopped が抜けていて、
 * 月間上限に達した実行が「枠切れで中断しただけ」と解釈され、DO が
 * 50ms 間隔でアラームを打ち直し続けた——毎周 R2 と D1 を読む無限
 * ループで、止める手立ては停止ボタンだけだった。
 *
 * 実行体そのものを回すには上流・D1・R2 の全部を差し替える必要があり、
 * ここでは配線だけを見る（file-deletion-wiring.test.ts と同じ形）。
 * 判定の構造を変えるときは、このテストも「新しい構造で同じ漏れが
 * 起きないか」を見る形へ書き換えること。
 */
describe("リトライ生成の続行判定", () => {
  const source = readFileSync("app/lib/generation.server.ts", "utf8");

  it("打ち切りの理由が3つとも続行判定に入っている", () => {
    const m = source.match(/const moreAttempts =[\s\S]*?;/);
    expect(m).not.toBeNull();
    const expr = m![0];
    expect(expr).toContain("!stopped");
    expect(expr).toContain("!rateLimitExhausted");
    expect(expr).toContain("!budgetStopped");
  });
});
