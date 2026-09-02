import { describe, expect, it } from "vitest";
import { dailyChart, daysInMonthJst, vendorOf } from "../app/lib/usage-chart";
import { JST_OFFSET_MS } from "../app/lib/usage";

/**
 * 使用量の日別グラフの下ごしらえ（UI-8）。
 *
 * SQL は記録のあった日しか返さないので、月初から今日までを欠けなく
 * 並べ直すのはここの仕事。境界（月初・今日）と、記録の無い日の扱いを見る。
 */
const DAY = 24 * 60 * 60 * 1000;
/** JST の日付を SQL の `day`（1970-01-01 JST からの日数）にする。 */
const jstDay = (iso: string) => Math.floor((Date.parse(iso) + JST_OFFSET_MS) / DAY);

const row = (
  iso: string,
  modelId: string | null,
  costUsd: number,
  pointsWithoutCost = 0,
) => ({
  day: jstDay(iso),
  modelId,
  provider: modelId?.startsWith("poe:") ? "poe" : "openrouter",
  costUsd,
  pointsWithoutCost,
});

describe("日別グラフ", () => {
  const now = Date.parse("2026-08-21T12:00:00+09:00");

  it("月初から今日までを欠けなく並べ、記録の無い日は 0 にする", () => {
    const { bars } = dailyChart(
      [row("2026-08-03T10:00:00+09:00", "openai/gpt-4o", 1)],
      now,
      0,
    );
    expect(bars.map((b) => b.dayOfMonth)).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1),
    );
    expect(bars[2].usd).toBe(1);
    expect(bars.filter((b) => b.usd > 0)).toHaveLength(1);
    // 棒の日付は JST の 0 時
    expect(bars[0].at).toBe(Date.parse("2026-08-01T00:00:00+09:00"));
  });

  it("JST の 0 時を跨ぐ記録は、JST の日付のほうに入る", () => {
    // UTC では 8/2 15:00 だが JST では 8/3 0:00
    const { bars } = dailyChart(
      [row("2026-08-03T00:00:00+09:00", "openai/gpt-4o", 2)],
      now,
      0,
    );
    expect(bars[2].usd).toBe(2);
    expect(bars[1].usd).toBe(0);
  });

  it("月初が今日なら棒は1本", () => {
    const { bars } = dailyChart([], Date.parse("2026-09-01T00:30:00+09:00"), 0);
    expect(bars).toHaveLength(1);
  });

  it("ベンダーで色分けし、額の多い順に並べる", () => {
    const { vendors, bars } = dailyChart(
      [
        row("2026-08-05T10:00:00+09:00", "openai/gpt-4o", 1),
        row("2026-08-05T11:00:00+09:00", "anthropic/claude", 3),
        row("2026-08-06T10:00:00+09:00", "anthropic/claude-2", 1),
        row("2026-08-06T10:00:00+09:00", "poe:Imagen-4", 0.5),
      ],
      now,
      0,
    );
    expect(vendors.map((v) => v.vendor)).toEqual(["anthropic", "openai", "poe"]);
    expect(vendors[0].usd).toBe(4);
    // 棒の内訳はベンダーの並びと同じ順で、無いベンダーも 0 で入る
    expect(bars[4].parts).toEqual([
      { vendor: "anthropic", usd: 3 },
      { vendor: "openai", usd: 1 },
      { vendor: "poe", usd: 0 },
    ]);
    expect(bars[5].usd).toBe(1.5);
  });

  it("額の取れなかったポイントは、換算レートがあるときだけ足す", () => {
    const rows = [row("2026-08-05T10:00:00+09:00", "poe:Claude", 0, 1000)];
    expect(dailyChart(rows, now, 0).bars[4].usd).toBe(0);
    expect(dailyChart(rows, now, 0.00002).bars[4].usd).toBeCloseTo(0.02);
  });

  it("上限の計算と同じで、レート 0 のときはポイントだけの行はベンダーに数えない", () => {
    const rows = [row("2026-08-05T10:00:00+09:00", "poe:Claude", 0, 1000)];
    expect(dailyChart(rows, now, 0).vendors).toEqual([]);
  });
});

describe("vendorOf", () => {
  it("OpenRouter は先頭、Poe はひとまとめ、モデル不明なら provider", () => {
    expect(vendorOf("anthropic/claude-sonnet", "openrouter")).toBe("anthropic");
    expect(vendorOf("poe:GPT-4o", "poe")).toBe("poe");
    expect(vendorOf(null, "openrouter")).toBe("openrouter");
    expect(vendorOf("gpt-4o", "openrouter")).toBe("openrouter");
  });
});

describe("daysInMonthJst", () => {
  it("JST で月を決める（UTC ではまだ前の月でも）", () => {
    // UTC 8/31 15:30 = JST 9/1 0:30
    expect(daysInMonthJst(Date.parse("2026-09-01T00:30:00+09:00"))).toBe(30);
    expect(daysInMonthJst(Date.parse("2026-08-31T23:30:00+09:00"))).toBe(31);
    expect(daysInMonthJst(Date.parse("2028-02-10T00:00:00+09:00"))).toBe(29);
  });
});
