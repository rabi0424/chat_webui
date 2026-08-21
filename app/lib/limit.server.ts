/**
 * 月間の上限判定。
 *
 * 判定そのものの計算は lib/usage.ts（純粋な関数）にあり、ここは
 * 設定・台帳・為替を集めて渡す係。呼ぶのは生成の入口と、リトライ生成の
 * 発射ループの2箇所。
 */
import { getAppSettings, readStoredUsdJpy, usageTotalsSince } from "./db.server";
import { fetchUsdJpy } from "./fx.server";
import { checkLimit, monthStartJst, type LimitVerdict } from "./usage";

/**
 * 判定に使う為替レート。
 *
 * まず保存してあるものを読む。無いときだけ外部から取りに行く
 * （Durable Object の中では外部リクエストが数えられているので、
 * 毎回は叩かない）。どちらも取れなければ null で、判定は通す側に倒れる。
 */
async function rateForLimit(): Promise<number | null> {
  const stored = await readStoredUsdJpy();
  if (stored != null) return stored;
  return await fetchUsdJpy();
}

/** 今月の使用量が上限に達しているか。 */
export async function checkMonthlyLimit(
  now = Date.now(),
): Promise<LimitVerdict> {
  const settings = await getAppSettings();
  // 上限を設けていないなら、集計も為替も要らない
  if (!(settings.monthlyLimitJpy > 0)) {
    return {
      blocked: false,
      reason: "no-limit",
      usedJpy: null,
      limitJpy: 0,
      estimated: false,
    };
  }
  const [totals, usdJpy] = await Promise.all([
    usageTotalsSince(monthStartJst(now)),
    rateForLimit(),
  ]);
  return checkLimit({
    limitJpy: settings.monthlyLimitJpy,
    usdJpy,
    totals,
    pointsUsdRate: settings.poePointsUsdRate,
    overrideMonth: settings.monthlyLimitOverride,
    now,
  });
}

/** 止めたときに画面へ出す文言。 */
export function limitMessage(v: LimitVerdict): string {
  const used = v.usedJpy != null ? `約${Math.round(v.usedJpy)}円` : "不明";
  return (
    `今月の使用額が上限に達しました（${used} / 上限 ${v.limitJpy}円）。` +
    `設定画面から上限を変えるか、今月だけ一時解除できます。`
  );
}
