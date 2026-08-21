import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../app/lib/settings";
import { EMPTY_TOTALS, type UsageTotals } from "../app/lib/usage";

/**
 * 上限判定の配線。
 *
 * 計算そのものは usage.ts のテストが見ている。ここが見るのは
 * 「設定・台帳・為替を正しく集めて渡しているか」——渡し忘れても型は
 * 通るので、上限が黙って効かなくなる形で壊れる。
 */
const settings = vi.hoisted(() => ({ value: {} as AppSettings }));
const totals = vi.hoisted(() => ({ value: {} as UsageTotals, calls: 0 }));
const stored = vi.hoisted(() => ({ value: null as number | null }));
const live = vi.hoisted(() => ({ value: null as number | null, calls: 0 }));

vi.mock("../app/lib/db.server", () => ({
  getAppSettings: async () => settings.value,
  usageTotalsSince: async () => {
    totals.calls++;
    return totals.value;
  },
  readStoredUsdJpy: async () => stored.value,
}));
vi.mock("../app/lib/fx.server", () => ({
  fetchUsdJpy: async () => {
    live.calls++;
    return live.value;
  },
}));

const { checkMonthlyLimit } = await import("../app/lib/limit.server");

/** JST の時刻を epoch ms に。 */
const jst = (s: string) => Date.parse(`${s}+09:00`);
const NOW = jst("2026-08-21T12:00:00");

beforeEach(() => {
  settings.value = { ...DEFAULT_APP_SETTINGS };
  totals.value = { ...EMPTY_TOTALS };
  totals.calls = 0;
  stored.value = 150;
  live.value = 150;
  live.calls = 0;
});

describe("上限判定の組み立て", () => {
  it("上限を設けていなければ、集計も為替も見に行かない", async () => {
    settings.value.monthlyLimitJpy = 0;
    const v = await checkMonthlyLimit(NOW);
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe("no-limit");
    expect(totals.calls).toBe(0);
    expect(live.calls).toBe(0);
  });

  it("上限を超えていれば止める", async () => {
    settings.value.monthlyLimitJpy = 500;
    totals.value = { ...EMPTY_TOTALS, costUsd: 10 };
    const v = await checkMonthlyLimit(NOW);
    expect(v.blocked).toBe(true);
    expect(v.usedJpy).toBeCloseTo(1500);
  });

  it("下回っていれば通す", async () => {
    settings.value.monthlyLimitJpy = 500;
    totals.value = { ...EMPTY_TOTALS, costUsd: 1 };
    expect((await checkMonthlyLimit(NOW)).blocked).toBe(false);
  });

  it("保存してある為替を使い、外へは取りに行かない", async () => {
    settings.value.monthlyLimitJpy = 500;
    totals.value = { ...EMPTY_TOTALS, costUsd: 10 };
    await checkMonthlyLimit(NOW);
    expect(live.calls).toBe(0);
  });

  it("保存が無いときだけ外へ取りに行く", async () => {
    settings.value.monthlyLimitJpy = 500;
    stored.value = null;
    totals.value = { ...EMPTY_TOTALS, costUsd: 10 };
    const v = await checkMonthlyLimit(NOW);
    expect(live.calls).toBe(1);
    expect(v.blocked).toBe(true);
  });

  it("為替がどこからも取れなければ通す", async () => {
    settings.value.monthlyLimitJpy = 500;
    stored.value = null;
    live.value = null;
    totals.value = { ...EMPTY_TOTALS, costUsd: 10_000 };
    const v = await checkMonthlyLimit(NOW);
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe("no-rate");
  });

  it("当月の一時解除が効く", async () => {
    settings.value.monthlyLimitJpy = 500;
    settings.value.monthlyLimitOverride = "2026-08";
    totals.value = { ...EMPTY_TOTALS, costUsd: 10 };
    const v = await checkMonthlyLimit(NOW);
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe("override");
  });

  it("先月の一時解除は効かない", async () => {
    settings.value.monthlyLimitJpy = 500;
    settings.value.monthlyLimitOverride = "2026-07";
    totals.value = { ...EMPTY_TOTALS, costUsd: 10 };
    expect((await checkMonthlyLimit(NOW)).blocked).toBe(true);
  });

  it("Poe の換算レートが設定に効く", async () => {
    settings.value.monthlyLimitJpy = 500;
    settings.value.poePointsUsdRate = 0.001;
    totals.value = { ...EMPTY_TOTALS, pointsWithoutCost: 10_000 };
    const v = await checkMonthlyLimit(NOW);
    // 10,000pt × $0.001 × 150 = ¥1,500
    expect(v.blocked).toBe(true);
    expect(v.estimated).toBe(true);
  });

  it("換算レートが0なら、ポイントは上限に効かない", async () => {
    settings.value.monthlyLimitJpy = 500;
    settings.value.poePointsUsdRate = 0;
    totals.value = { ...EMPTY_TOTALS, pointsWithoutCost: 10_000 };
    expect((await checkMonthlyLimit(NOW)).blocked).toBe(false);
  });
});
