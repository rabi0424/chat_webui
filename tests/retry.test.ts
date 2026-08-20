import { describe, expect, it } from "vitest";
import {
  formatRetryProgress,
  isRetryProgress,
  readRetryConfig,
  RETRY_CONCURRENCY_KEY,
  RETRY_ENABLED_KEY,
  RETRY_MAX_KEY,
  RETRY_TARGET_KEY,
} from "../app/lib/retry";

/**
 * リトライ生成の設定は「課金の天井」を決める。
 * 上限を1つ読み違えるだけで、意図した何倍もの生成が走ってしまうため、
 * クライアントが何を送ってきても天井を越えないことを確かめる。
 */
const on = (extra: Record<string, number | string> = {}) => ({
  [RETRY_ENABLED_KEY]: "on",
  ...extra,
});

describe("readRetryConfig", () => {
  it("無効なら null を返す", () => {
    expect(readRetryConfig(null, 100)).toBeNull();
    expect(readRetryConfig(undefined, 100)).toBeNull();
    expect(readRetryConfig({}, 100)).toBeNull();
    expect(readRetryConfig({ [RETRY_ENABLED_KEY]: "off" }, 100)).toBeNull();
    // "on" 以外の値では有効にしない
    expect(readRetryConfig({ [RETRY_ENABLED_KEY]: "true" }, 100)).toBeNull();
    expect(readRetryConfig({ [RETRY_ENABLED_KEY]: 1 }, 100)).toBeNull();
  });

  it("未指定なら試行回数と並列数を目標数に合わせる", () => {
    expect(readRetryConfig(on({ [RETRY_TARGET_KEY]: 3 }), 100)).toEqual({
      target: 3,
      maxAttempts: 3,
      concurrency: 3,
    });
  });

  it("試行回数はアプリ全体の天井を超えない", () => {
    const c = readRetryConfig(
      on({ [RETRY_TARGET_KEY]: 5, [RETRY_MAX_KEY]: 9999 }),
      20,
    );
    expect(c?.maxAttempts).toBe(20);
  });

  it("並列数は試行回数を超えない", () => {
    const c = readRetryConfig(
      on({ [RETRY_TARGET_KEY]: 1, [RETRY_MAX_KEY]: 3, [RETRY_CONCURRENCY_KEY]: 50 }),
      100,
    );
    expect(c?.concurrency).toBe(3);
  });

  it("壊れた値・負の値・小数でも天井を割らない", () => {
    for (const bad of ["abc", "", -1, 0, NaN, Infinity, "-5", null, undefined]) {
      const c = readRetryConfig(
        on({
          [RETRY_TARGET_KEY]: bad as never,
          [RETRY_MAX_KEY]: bad as never,
          [RETRY_CONCURRENCY_KEY]: bad as never,
        }),
        10,
      );
      expect(c).not.toBeNull();
      expect(c!.target).toBeGreaterThanOrEqual(1);
      expect(c!.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(c!.maxAttempts).toBeLessThanOrEqual(10);
      expect(c!.concurrency).toBeGreaterThanOrEqual(1);
      expect(c!.concurrency).toBeLessThanOrEqual(c!.maxAttempts);
    }
  });

  it("小数は丸めて整数にする", () => {
    const c = readRetryConfig(
      on({ [RETRY_TARGET_KEY]: 2.7, [RETRY_MAX_KEY]: 4.2 }),
      100,
    );
    expect(c).toEqual({ target: 3, maxAttempts: 4, concurrency: 3 });
  });

  it("天井が0や負でも、必ず1回は試せる形にする", () => {
    for (const ceiling of [0, -1, 0.4]) {
      const c = readRetryConfig(on({ [RETRY_TARGET_KEY]: 5 }), ceiling);
      expect(c!.maxAttempts).toBe(1);
      expect(c!.concurrency).toBe(1);
    }
  });

  it("文字列で送られた数値も読む（フォームからの値）", () => {
    expect(
      readRetryConfig(on({ [RETRY_TARGET_KEY]: "4", [RETRY_MAX_KEY]: "8" }), 100),
    ).toEqual({ target: 4, maxAttempts: 8, concurrency: 4 });
  });
});

describe("進捗の見出し", () => {
  const retry = { target: 10, maxAttempts: 100, concurrency: 4 };

  it("見出しとして判別できる形で書く", () => {
    const line = formatRetryProgress({
      successes: 2,
      attempts: 37,
      inflight: 4,
      retry,
    });
    expect(isRetryProgress(line)).toBe(true);
    expect(line).toContain("成功 2/10");
    expect(line).toContain("試行 37/100");
    expect(line).toContain("実行中 4本");
  });

  it("経過秒はサーバー側で書かない（クライアントが刻む）", () => {
    const line = formatRetryProgress({
      successes: 0,
      attempts: 0,
      inflight: 0,
      retry,
    });
    expect(line).not.toMatch(/秒|\d+s\b/);
  });

  it("通常の応答は見出しと誤判定しない", () => {
    expect(isRetryProgress("画像を生成しました。")).toBe(false);
    expect(isRetryProgress("")).toBe(false);
  });
});
