import { describe, expect, it } from "vitest";
import {
  EMPTY_TOTALS,
  checkLimit,
  effectiveUsd,
  monthLabelJst,
  monthStartJst,
  type UsageTotals,
} from "../app/lib/usage";

/**
 * 使用量と月間上限。
 *
 * 月の区切りは JST。UTC で切ると、月初の9時間ぶんが前の月に数えられ、
 * 「月が変わったのに上限が解けない」ことになる。
 */
const totals = (p: Partial<UsageTotals> = {}): UsageTotals => ({
  ...EMPTY_TOTALS,
  ...p,
});

/** JST の時刻を epoch ms に。 */
const jst = (s: string) => Date.parse(`${s}+09:00`);

describe("月の区切り", () => {
  it("JST の1日 00:00 で切る", () => {
    const start = monthStartJst(jst("2026-08-21T12:00:00"));
    expect(start).toBe(jst("2026-08-01T00:00:00"));
  });

  it("月初の午前0時ちょうどは、その月に入る", () => {
    const t = jst("2026-08-01T00:00:00");
    expect(monthStartJst(t)).toBe(t);
  });

  it("月初の午前8時は前の月に落ちない（UTCで切ると落ちる）", () => {
    // UTC では 2026-07-31T23:00Z。素朴に UTC で切ると7月扱いになる
    const t = jst("2026-08-01T08:00:00");
    expect(monthStartJst(t)).toBe(jst("2026-08-01T00:00:00"));
    expect(monthLabelJst(t)).toBe("2026-08");
  });

  it("月末の23時台はまだその月", () => {
    const t = jst("2026-08-31T23:30:00");
    expect(monthStartJst(t)).toBe(jst("2026-08-01T00:00:00"));
    expect(monthLabelJst(t)).toBe("2026-08");
  });

  it("年をまたぐ", () => {
    const t = jst("2026-01-05T10:00:00");
    expect(monthStartJst(t)).toBe(jst("2026-01-01T00:00:00"));
    expect(monthLabelJst(t)).toBe("2026-01");
  });
});

describe("実効額", () => {
  it("額が取れている分はそのまま足す", () => {
    expect(effectiveUsd(totals({ costUsd: 1.5 }), 0.001)).toBeCloseTo(1.5);
  });

  it("額が取れなかったポイントは、レートで見積もって足す", () => {
    const t = totals({ costUsd: 1, points: 3000, pointsWithoutCost: 2000 });
    expect(effectiveUsd(t, 0.0005)).toBeCloseTo(1 + 1);
  });

  it("レートが0なら、ポイント分は数えない", () => {
    const t = totals({ costUsd: 1, pointsWithoutCost: 2000 });
    expect(effectiveUsd(t, 0)).toBeCloseTo(1);
  });
});

describe("上限の判定", () => {
  const base = {
    usdJpy: 150,
    pointsUsdRate: 0,
    overrideMonth: null,
    now: jst("2026-08-21T12:00:00"),
  };

  it("上限が0なら止めない", () => {
    const v = checkLimit({ ...base, limitJpy: 0, totals: totals({ costUsd: 99 }) });
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe("no-limit");
  });

  it("下回っていれば通す", () => {
    const v = checkLimit({ ...base, limitJpy: 500, totals: totals({ costUsd: 1 }) });
    expect(v.blocked).toBe(false);
    expect(v.usedJpy).toBeCloseTo(150);
  });

  it("超えたら止める", () => {
    const v = checkLimit({ ...base, limitJpy: 500, totals: totals({ costUsd: 4 }) });
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("over");
  });

  it("ちょうど上限でも止める", () => {
    const v = checkLimit({
      ...base,
      limitJpy: 500,
      totals: totals({ costUsd: 500 / 150 }),
    });
    expect(v.blocked).toBe(true);
  });

  it("当月の一時解除が効いているあいだは通す", () => {
    const v = checkLimit({
      ...base,
      limitJpy: 500,
      totals: totals({ costUsd: 99 }),
      overrideMonth: "2026-08",
    });
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe("override");
  });

  it("先月の一時解除は効かない", () => {
    const v = checkLimit({
      ...base,
      limitJpy: 500,
      totals: totals({ costUsd: 99 }),
      overrideMonth: "2026-07",
    });
    expect(v.blocked).toBe(true);
  });

  it("為替が取れないときは通す（黙って止めない）", () => {
    const v = checkLimit({
      ...base,
      usdJpy: null,
      limitJpy: 500,
      totals: totals({ costUsd: 99 }),
    });
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe("no-rate");
    expect(v.usedJpy).toBeNull();
  });

  it("ポイントの見積もりが混ざったら、そう分かる", () => {
    const v = checkLimit({
      ...base,
      limitJpy: 500,
      pointsUsdRate: 0.0005,
      totals: totals({ pointsWithoutCost: 2000 }),
    });
    expect(v.estimated).toBe(true);
    expect(v.usedJpy).toBeCloseTo(150);
  });

  it("見積もったポイントだけでも上限に達する", () => {
    const v = checkLimit({
      ...base,
      limitJpy: 500,
      pointsUsdRate: 0.0005,
      totals: totals({ pointsWithoutCost: 8000 }),
    });
    expect(v.blocked).toBe(true);
  });
});
