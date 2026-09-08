import { describe, expect, it } from "vitest";
import {
  RETRY_SMART_WARMUP_ATTEMPTS,
  binomialCdf,
  planRetrySlots,
  upperSuccessRate,
} from "../app/lib/retry-slots";

/**
 * スマート生成の枠の決め方。
 *
 * ここで決める数は「何本ぶん課金されうるか」に直結する。枠を1本
 * 読み違えると、成功が一斉に届いたときの超過がそのまま増える。
 */
const base = {
  target: 1,
  successes: 0,
  attempts: 0,
  maxAttempts: 60,
  cap: 12,
  percent: 10,
};

describe("二項分布", () => {
  it("累積確率が手計算と合う", () => {
    // Bin(4, 0.5): P(X ≤ 1) = (1 + 4) / 16
    expect(binomialCdf(1, 4, 0.5)).toBeCloseTo(5 / 16, 10);
    // Bin(10, 0.3): P(X ≤ 2) = 0.3828…
    expect(binomialCdf(2, 10, 0.3)).toBeCloseTo(0.38278, 4);
    // Bin(3, 0.2): P(X ≤ 0) = 0.8^3
    expect(binomialCdf(0, 3, 0.2)).toBeCloseTo(0.512, 10);
  });

  it("端では確率の定義どおり", () => {
    expect(binomialCdf(-1, 5, 0.5)).toBe(0);
    expect(binomialCdf(5, 5, 0.5)).toBe(1);
    expect(binomialCdf(9, 5, 0.5)).toBe(1);
    expect(binomialCdf(0, 5, 0)).toBe(1);
    expect(binomialCdf(4, 5, 1)).toBe(0);
  });

  it("大きな試行数でも桁あふれしない", () => {
    expect(binomialCdf(500, 1000, 0.5)).toBeCloseTo(0.5126, 3);
    expect(Number.isFinite(binomialCdf(10, 2000, 0.9))).toBe(true);
  });
});

describe("upperSuccessRate（下位 n% のはずれだったとしたときの率）", () => {
  it("全部失敗なら 1 − (n/100)^(1/a)", () => {
    expect(upperSuccessRate({ successes: 0, attempts: 4, percent: 10 })).toBeCloseTo(
      1 - 0.1 ** (1 / 4),
      6,
    );
    expect(upperSuccessRate({ successes: 0, attempts: 10, percent: 30 })).toBeCloseTo(
      1 - 0.3 ** (1 / 10),
      6,
    );
  });

  it("求めた率のもとで、観測以下になる確率がちょうど n%", () => {
    for (const [s, a, n] of [
      [2, 10, 10],
      [1, 12, 25],
      [5, 20, 5],
    ]) {
      const p = upperSuccessRate({ successes: s, attempts: a, percent: n });
      expect(binomialCdf(s, a, p)).toBeCloseTo(n / 100, 6);
    }
  });

  it("観測が無い・全部成功なら 1", () => {
    expect(upperSuccessRate({ successes: 0, attempts: 0, percent: 10 })).toBe(1);
    expect(upperSuccessRate({ successes: 3, attempts: 3, percent: 10 })).toBe(1);
  });

  it("n が大きいほど、はずれを軽く見るので率は低くなる", () => {
    const at = (n: number) =>
      upperSuccessRate({ successes: 2, attempts: 10, percent: n });
    expect(at(5)).toBeGreaterThan(at(10));
    expect(at(10)).toBeGreaterThan(at(30));
    expect(at(30)).toBeGreaterThan(at(50));
  });
});

describe("planRetrySlots", () => {
  it("溜まるまでは残りの目標を超える枠を開けない", () => {
    // 境界は定数ではなく数で書く。定数だけを見て回すと、定数が 0 に
    // なったとき（＝溜める前に統計へ入る）ループが回らず何も見ない
    expect(RETRY_SMART_WARMUP_ATTEMPTS).toBe(10);
    expect(planRetrySlots({ ...base, attempts: 9, percent: 50 })).toBe(1);
    expect(planRetrySlots({ ...base, attempts: 10, percent: 50 })).toBeGreaterThan(1);
    for (let a = 0; a < 10; a++) {
      expect(planRetrySlots({ ...base, attempts: a })).toBe(1);
      expect(planRetrySlots({ ...base, target: 3, attempts: a })).toBe(3);
      // 失敗ばかりでも、割合を大きくしても、同じ
      expect(planRetrySlots({ ...base, attempts: a, percent: 50 })).toBe(1);
    }
    // 残りは成功を引いた数
    expect(
      planRetrySlots({ ...base, target: 3, successes: 2, attempts: 5 }),
    ).toBe(1);
  });

  it("溜まったら、上位 n% のあたりでも残りを超えない最大の枠を開ける", () => {
    // 10本全部失敗・n=10: 率は 1 − 0.1^0.1 ≈ 0.206。
    // 2本で2本とも通る確率 0.042 ≤ 0.1、3本で2本以上は 0.11 > 0.1
    expect(planRetrySlots({ ...base, attempts: 10 })).toBe(2);
    const p = upperSuccessRate({ successes: 0, attempts: 10, percent: 10 });
    expect(1 - binomialCdf(1, 2, p)).toBeLessThanOrEqual(0.1);
    expect(1 - binomialCdf(1, 3, p)).toBeGreaterThan(0.1);
    // n=30 なら、はずれを軽く見るぶん率が下がり、枠は大きく広がる
    expect(planRetrySlots({ ...base, attempts: 10, percent: 30 })).toBe(9);
  });

  it("失敗が積もるほど広がり、途中で減らない", () => {
    let prev = 0;
    for (let a = RETRY_SMART_WARMUP_ATTEMPTS; a <= 40; a++) {
      const k = planRetrySlots({ ...base, attempts: a, cap: 100 });
      expect(k).toBeGreaterThanOrEqual(prev);
      prev = k;
    }
    expect(prev).toBeGreaterThan(planRetrySlots({ ...base, attempts: 10 }));
  });

  it("成功が届くと残りの目標に合わせて縮み、届いたら 0", () => {
    // 目標3、12本中2本成功。率の上限は高めなので、残り1に対して枠は控えめ
    const k = planRetrySlots({ ...base, target: 3, successes: 2, attempts: 12 });
    expect(k).toBeGreaterThanOrEqual(1);
    expect(k).toBeLessThan(planRetrySlots({ ...base, target: 3, attempts: 12 }));
    expect(
      planRetrySlots({ ...base, target: 3, successes: 3, attempts: 12 }),
    ).toBe(0);
    expect(
      planRetrySlots({ ...base, target: 3, successes: 5, attempts: 12 }),
    ).toBe(0);
  });

  it("利用者の上限と、試行回数の残りを超えない", () => {
    // 30本全部失敗・n=30 なら、素直に広げれば cap 12 を超える
    expect(
      planRetrySlots({ ...base, attempts: 30, percent: 30, cap: 100 }),
    ).toBeGreaterThan(12);
    expect(planRetrySlots({ ...base, attempts: 30, percent: 30 })).toBe(12);
    expect(
      planRetrySlots({ ...base, attempts: 30, percent: 30, cap: 100, maxAttempts: 33 }),
    ).toBe(3);
    expect(
      planRetrySlots({ ...base, attempts: 60, percent: 30, cap: 100 }),
    ).toBe(0);
    // 溜まる前も同じ締めが効く
    expect(planRetrySlots({ ...base, target: 5, attempts: 2, cap: 2 })).toBe(2);
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
): { overshoot: number; overshootRuns: number; attempts: number; reached: number } {
  const runs = 2000;
  const rand = lcg(seed);
  let overshoot = 0;
  let overshootRuns = 0;
  let attempts = 0;
  let reached = 0;
  for (let i = 0; i < runs; i++) {
    const t = simulate(p, target, slotsOf, { maxAttempts: 60, rand });
    overshoot += Math.max(0, t.successes - target);
    if (t.successes > target) overshootRuns++;
    attempts += t.attempts;
    if (t.successes >= target) reached++;
  }
  return {
    overshoot: overshoot / runs,
    overshootRuns: overshootRuns / runs,
    attempts: attempts / runs,
    reached: reached / runs,
  };
}

describe("固定の並列数との比較（模擬）", () => {
  const cap = 12;
  const smart = (target: number, percent: number) => (t: Trial) =>
    planRetrySlots({ ...t, target, maxAttempts: 60, cap, percent });
  const fixed = () => cap;

  for (const p of [0.1, 0.3, 0.6]) {
    for (const target of [1, 3]) {
      it(`成功率 ${p}・目標 ${target}: 超過も試行も減り、届く率は落ちない`, () => {
        const a = average(p, target, smart(target, 10), 12345);
        const b = average(p, target, fixed, 12345);
        expect(a.overshoot).toBeLessThan(b.overshoot);
        expect(a.attempts).toBeLessThan(b.attempts);
        // 届く率は上限の試行回数で決まるので、絞っても落ちない
        expect(a.reached).toBeGreaterThanOrEqual(b.reached - 0.01);
      });
    }
  }

  it("n=10 なら、目標を超える実行はおおむね n% に収まる", () => {
    // 1束ごとの超過は n% 以下、束は何度か続くので少し積む。
    // それでも固定並列（超過がほぼ毎回）とは桁が違う
    for (const p of [0.1, 0.3]) {
      const a = average(p, 1, smart(1, 10), 777);
      expect(a.overshootRuns).toBeLessThan(0.2);
    }
  });

  it("n を大きくすると、速さと引き換えに超過が増える（つまみが効いている）", () => {
    const cautious = average(0.1, 1, smart(1, 5), 4242);
    const bold = average(0.1, 1, smart(1, 40), 4242);
    expect(bold.overshoot).toBeGreaterThan(cautious.overshoot);
    expect(bold.attempts).toBeGreaterThan(cautious.attempts);
  });
});
