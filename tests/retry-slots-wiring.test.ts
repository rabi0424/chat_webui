import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * スマート生成の配線。
 *
 * 枠を決める関数（planRetrySlots）は純粋で、tests/retry-slots.test.ts が
 * 細かく見ている。ただし司令役がそれを呼ばず `retry.concurrency` を
 * 直接見ていても、画面にはスマートの表示が出て、走るのは固定の並列数
 * ——という壊れ方をする。誰も気づけないので、配線を見張る
 * （retry-stop-wiring.test.ts と同じ形）。
 */
describe("スマート生成の配線", () => {
  const source = readFileSync("app/lib/retry-run.server.ts", "utf8");

  it("担当を起こすループは並列数を直接見ず、枠の計算を通す", () => {
    const loop = source.match(
      /\/\/ 目標に届くまで、上限と並列数の範囲で担当を起こし続ける[\s\S]*?while \([\s\S]*?\) \{/,
    );
    expect(loop).not.toBeNull();
    expect(loop![0]).toContain("running < slots()");
    expect(loop![0]).not.toContain("retry.concurrency");
  });

  it("枠の計算はスマートのときだけ planRetrySlots に任せる", () => {
    const slots = source.match(/const slots = \(\): number =>[\s\S]*?;/);
    expect(slots).not.toBeNull();
    expect(slots![0]).toContain("retry.smartPercent != null");
    expect(slots![0]).toContain("planRetrySlots(");
    expect(slots![0]).toContain("cap: retry.concurrency");
    expect(slots![0]).toContain("percent: retry.smartPercent");
  });
});
