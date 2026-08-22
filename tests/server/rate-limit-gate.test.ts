import { describe, expect, it } from "vitest";

import { createRateLimitGate } from "../../app/lib/generation.server";

/**
 * レート制限の見張り（A-9）。
 *
 * 残り枠は `x-ratelimit-remaining-requests` から読むが、**このヘッダを
 * 返さない上流のほうが多い**。`headers.get()` は無いとき null を返し、
 * `Number(null)` は 0 になる。0 は有限なので `Number.isFinite` の関門は
 * 素通りし、「枠が尽きた」と判断してしまう。結果、枠の情報を出さない
 * 上流では毎回ここで待たされる（最大60秒）。
 */

const res = (headers: Record<string, string>) => new Response("", { headers });

describe("残り枠の読み取り", () => {
  it("ヘッダが無ければ待たない", () => {
    const gate = createRateLimitGate();
    gate.note(res({}));
    expect(gate.until()).toBe(0);
  });

  it("ヘッダが無いとき、reset を言われていても待たない", () => {
    // 「残り0」と誤読すると reset の値をそのまま待ち時間にしてしまう。
    // 待ち時間の出どころを塞いでも、この経路が残っていれば意味がない
    const gate = createRateLimitGate();
    gate.note(res({ "x-ratelimit-reset-requests": "30s" }));
    expect(gate.until()).toBe(0);
  });

  it("数値でない値でも待たない", () => {
    const gate = createRateLimitGate();
    gate.note(res({ "x-ratelimit-remaining-requests": "unknown" }));
    expect(gate.until()).toBe(0);
  });

  it("残りが十分あれば待たない", () => {
    const gate = createRateLimitGate();
    gate.note(res({ "x-ratelimit-remaining-requests": "50" }));
    expect(gate.until()).toBe(0);
  });

  it("残り0と明示されたら待つ", () => {
    const gate = createRateLimitGate();
    const before = Date.now();
    gate.note(res({ "x-ratelimit-remaining-requests": "0" }));
    expect(gate.until()).toBeGreaterThan(before);
  });

  it("残り0と reset があれば、その分だけ待つ", () => {
    const gate = createRateLimitGate();
    const before = Date.now();
    gate.note(
      res({
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "30s",
      }),
    );
    // reset を読まずに既定の1秒で済ませていないことまで見る
    expect(gate.until()).toBeGreaterThan(before + 25_000);
    expect(gate.until()).toBeLessThanOrEqual(before + 30_000 + 1000);
  });

  it("待ち時間は上限で頭打ちになる", () => {
    const gate = createRateLimitGate();
    const before = Date.now();
    gate.note(
      res({
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "1h",
      }),
    );
    expect(gate.until()).toBeLessThanOrEqual(before + 60_000 + 1000);
  });

  it("待ち時間は短いほうへ巻き戻らない", () => {
    const gate = createRateLimitGate();
    gate.note(
      res({
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "30s",
      }),
    );
    const far = gate.until();
    gate.note(
      res({
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "1s",
      }),
    );
    expect(gate.until()).toBe(far);
  });
});
