import { describe, expect, it } from "vitest";
import {
  RETRY_SLOT_OPTIMISM,
  estimateSuccessRate,
  planRetrySlots,
} from "../app/lib/retry-slots";

/**
 * スマート連続生成の枠の決め方。
 *
 * ここで決める数は「何本ぶん課金されうるか」に直結する。枠を1本
 * 読み違えると、成功が一斉に届いたときの超過がそのまま増える。
 */
const base = { target: 1, successes: 0, attempts: 0, maxAttempts: 40, cap: 8 };

describe("planRetrySlots", () => {
  it("最初は残りの目標と同じ本数だけ開ける（率は1とみなす）", () => {
    expect(planRetrySlots({ ...base, target: 1 })).toBe(1);
    expect(planRetrySlots({ ...base, target: 3 })).toBe(3);
    expect(estimateSuccessRate({ successes: 0, attempts: 0 })).toBe(1);
  });

  it("失敗が続くと少しずつ広がる。失敗の数ほど速くは広げない", () => {
    // 見えている成功に上乗せする本数（2）ぶんだけ、失敗を疑って見る。
    // 失敗 n 本のあと、見込みは 2/(n+2)、枠は ceil((n+2)/2)
    const seen = [1, 2, 3, 4, 5, 6, 8, 10].map((n) =>
      planRetrySlots({ ...base, attempts: n }),
    );
    expect(seen).toEqual([2, 2, 3, 3, 4, 4, 5, 6]);
    // 単調に増える（減ると、失敗が届くたびに枠が揺れて読めなくなる）
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
  });

  it("観測した率をそのまま使うより枠を絞る（下振れの最中を見越す）", () => {
    // 目標2で、5本投げて1本成功。観測率は 0.2 で、素直に割れば残り1に
    // 5本開ける。上乗せ後の見込みは 3/7 ≈ 0.43 なので3本で止める
    expect(
      planRetrySlots({ ...base, target: 2, successes: 1, attempts: 5 }),
    ).toBe(3);
    expect(Math.ceil(1 / (1 / 5))).toBe(5);
  });

  it("上乗せは失敗が積もるほど薄れ、観測した率へ近づく", () => {
    const observed = 0.25;
    const gap = (n: number) =>
      Math.abs(
        estimateSuccessRate({ successes: n * observed, attempts: n }) -
          observed,
      );
    expect(gap(4)).toBeGreaterThan(gap(40));
    expect(gap(40)).toBeGreaterThan(gap(400));
    expect(gap(400)).toBeLessThan(0.01);
  });

  it("成功が届くと残りの目標に合わせて縮む", () => {
    // 目標3で、4本投げて2本成功。残り1、見込み 4/6 → 2本
    expect(
      planRetrySlots({ ...base, target: 3, successes: 2, attempts: 4 }),
    ).toBe(2);
    // 目標に届いたら0
    expect(
      planRetrySlots({ ...base, target: 3, successes: 3, attempts: 4 }),
    ).toBe(0);
    expect(
      planRetrySlots({ ...base, target: 3, successes: 5, attempts: 6 }),
    ).toBe(0);
  });

  it("利用者の上限と、試行回数の残りを超えない", () => {
    // 失敗20本なら見込みは 2/22、素直に割れば11本
    expect(planRetrySlots({ ...base, attempts: 20, cap: 4 })).toBe(4);
    expect(
      planRetrySlots({ ...base, attempts: 20, cap: 100, maxAttempts: 23 }),
    ).toBe(3);
    expect(
      planRetrySlots({ ...base, attempts: 40, cap: 100, maxAttempts: 40 }),
    ).toBe(0);
  });
});

/**
 * 固定の並列数と比べて、目標を超えて受け取る本数（＝無駄な課金）が
 * 実際に減るか。上流を「走っている分がほぼ同時に返る」形で模す。
 * これが超過の一番出やすい形で、利用者が避けたい事態そのもの。
 *
 * 乱数は種を固定した LCG。実行のたびに結果が揺れると、落ちたときに
 * 何が変わったのか追えない。
 */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

interface Trial {
  successes: number;
  attempts: number;
}

/** 空き枠を埋めては全部の結果を待つ、を目標に届くまで繰り返す。 */
function simulate(
  p: number,
  target: number,
  slotsOf: (t: Trial) => number,
  opts: { maxAttempts: number; rand: () => number },
): Trial {
  const t: Trial = { successes: 0, attempts: 0 };
  while (t.successes < target && t.attempts < opts.maxAttempts) {
    const n = Math.min(slotsOf(t), opts.maxAttempts - t.attempts);
    if (n <= 0) break;
    for (let i = 0; i < n; i++) {
      t.attempts++;
      if (opts.rand() < p) t.successes++;
    }
  }
  return t;
}

function average(
  p: number,
  target: number,
  slotsOf: (t: Trial) => number,
  seed: number,
): { overshoot: number; attempts: number; reached: number } {
  const runs = 2000;
  const rand = lcg(seed);
  let overshoot = 0;
  let attempts = 0;
  let reached = 0;
  for (let i = 0; i < runs; i++) {
    const t = simulate(p, target, slotsOf, { maxAttempts: 40, rand });
    overshoot += Math.max(0, t.successes - target);
    attempts += t.attempts;
    if (t.successes >= target) reached++;
  }
  return {
    overshoot: overshoot / runs,
    attempts: attempts / runs,
    reached: reached / runs,
  };
}

describe("固定の並列数との比較（模擬）", () => {
  const cap = 8;
  const smart = (target: number) => (t: Trial) =>
    planRetrySlots({ ...t, target, maxAttempts: 40, cap });
  const fixed = () => cap;

  for (const p of [0.2, 0.5, 0.8]) {
    for (const target of [1, 3]) {
      it(`成功率 ${p}・目標 ${target}: 超過も試行も減り、届く率は落ちない`, () => {
        const a = average(p, target, smart(target), 12345);
        const b = average(p, target, fixed, 12345);
        expect(a.overshoot).toBeLessThan(b.overshoot);
        expect(a.attempts).toBeLessThan(b.attempts);
        // 届く率は上限の試行回数で決まるので、絞っても落ちない
        expect(a.reached).toBeGreaterThanOrEqual(b.reached - 0.01);
      });
    }
  }

  it("上乗せの本数を変えると枠の増え方が変わる（定数が効いているか）", () => {
    // 定数そのものは 2。これが 0 になると最初の見込みが 0/0 になり、
    // 大きすぎると失敗が続いても枠が広がらない
    expect(RETRY_SLOT_OPTIMISM).toBe(2);
    expect(estimateSuccessRate({ successes: 0, attempts: 1 })).toBe(
      RETRY_SLOT_OPTIMISM / (1 + RETRY_SLOT_OPTIMISM),
    );
  });
});
