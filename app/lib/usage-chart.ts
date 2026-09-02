/**
 * 使用量の日別グラフの下ごしらえ（UI-8）。
 *
 * DB にも画面にも触らない純粋な変換だけを置く。SQL が返すのは
 * 「記録のあった日 × モデル」の行で、記録の無い日は行が無い。グラフは
 * 月初から今日までを**欠けなく**並べたいので、ここで日を埋める。
 */
import {
  JST_OFFSET_MS,
  dayStartJst,
  effectiveUsd,
  monthStartJst,
} from "./usage";
import { isPoeModel } from "./constants";

const DAY_MS = 24 * 60 * 60 * 1000;

/** SQL が返す日別の1行（`app/lib/db.server.ts` の UsageDaily と同じ形）。 */
export interface DailyInput {
  /** 1970-01-01 JST からの日数（`USAGE_DAILY_SQL` の `day`）。 */
  day: number;
  modelId: string | null;
  provider: string;
  costUsd: number;
  pointsWithoutCost: number;
}

export interface DailyBar {
  /** 月の何日か（1始まり）。 */
  dayOfMonth: number;
  /** その日の始まり（JST 00:00、epoch ms）。 */
  at: number;
  /** ベンダーごとの実効ドル額。並びは `vendors` と同じ。 */
  parts: { vendor: string; usd: number }[];
  /** 合計（parts の和）。 */
  usd: number;
}

export interface DailyChartData {
  bars: DailyBar[];
  /** 色分けの単位。額の多い順。`sample` はその色を引くためのモデルID。 */
  vendors: { vendor: string; sample: string; usd: number }[];
}

/**
 * 色分けの単位。OpenRouter は `anthropic/claude-…` の先頭の名前、
 * Poe はモデルごとに分けても意味が薄い（同じ財布から出る）ので
 * ひとまとめ。モデルIDが無い行は provider の名前で括る。
 */
export function vendorOf(modelId: string | null, provider: string): string {
  if (!modelId) return provider;
  if (isPoeModel(modelId)) return "poe";
  const head = modelId.split("/")[0];
  return head && head !== modelId ? head.toLowerCase() : provider;
}

/** 今月の日数（JST）。上限を1日あたりに割るときに使う。 */
export function daysInMonthJst(now: number): number {
  const d = new Date(now + JST_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * 月初から今日までの棒を作る。
 *
 * 額は上限の判定と同じ「実効ドル額」（実額 + 額が取れなかった
 * ポイント × 換算レート）。グラフだけ別の額で描くと、帯の割合と
 * 棒の高さが食い違って見える。
 */
export function dailyChart(
  rows: DailyInput[],
  now: number,
  pointsUsdRate: number,
): DailyChartData {
  const start = monthStartJst(now);
  const today = dayStartJst(now);
  const days = Math.round((today - start) / DAY_MS) + 1;

  const byVendor = new Map<string, { sample: string; usd: number }>();
  const byDay = new Map<number, Map<string, number>>();
  for (const r of rows) {
    const usd = effectiveUsd(
      { costUsd: r.costUsd, points: 0, pointsWithoutCost: r.pointsWithoutCost, events: 0 },
      pointsUsdRate,
    );
    if (!(usd > 0)) continue;
    const vendor = vendorOf(r.modelId, r.provider);
    const v = byVendor.get(vendor) ?? { sample: r.modelId ?? "", usd: 0 };
    v.usd += usd;
    if (!v.sample && r.modelId) v.sample = r.modelId;
    byVendor.set(vendor, v);
    // SQL の day は JST 0時からの日数。月初からの相対日に直す
    const rel = r.day - Math.floor((start + JST_OFFSET_MS) / DAY_MS);
    const dayMap = byDay.get(rel) ?? new Map<string, number>();
    dayMap.set(vendor, (dayMap.get(vendor) ?? 0) + usd);
    byDay.set(rel, dayMap);
  }

  const vendors = [...byVendor.entries()]
    .map(([vendor, v]) => ({ vendor, sample: v.sample, usd: v.usd }))
    .sort((a, b) => b.usd - a.usd);

  const bars: DailyBar[] = [];
  for (let i = 0; i < days; i++) {
    const dayMap = byDay.get(i);
    const parts = vendors.map((v) => ({
      vendor: v.vendor,
      usd: dayMap?.get(v.vendor) ?? 0,
    }));
    bars.push({
      dayOfMonth: i + 1,
      at: start + i * DAY_MS,
      parts,
      usd: parts.reduce((s, p) => s + p.usd, 0),
    });
  }
  return { bars, vendors };
}
