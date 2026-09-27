/**
 * 月間の上限判定。
 *
 * 判定そのものの計算は lib/usage.ts（純粋な関数）にあり、ここは
 * 設定・台帳・為替を集めて渡す係。呼ぶのは生成の入口と、リトライ生成の
 * 発射ループの2箇所。
 */
import {
  getAppSettings,
  readStoredUsdJpy,
  storeUsdJpy,
  usageTotalsSince,
} from "./db.server";
import { fetchUsdJpy } from "./fx.server";
import type { AppSettings } from "./settings";
import {
  checkLimit,
  monthStartJst,
  withProvisional,
  type LimitVerdict,
  type UsageTotals,
} from "./usage";

/**
 * 判定に使う為替レート。
 *
 * まず保存してあるものを使う。無いときだけ外部から取りに行く
 * （Durable Object の中では外部リクエストが数えられているので、
 * 毎回は叩かない）。どちらも取れなければ null で、判定は通す側に倒れる。
 */
async function rateForLimit(stored: number | null): Promise<number | null> {
  if (stored != null) return stored;
  // 取れたら書いておく。書かないと、保存が一度も無いあいだ判定のたびに
  // 外へ出ることになる——リトライ生成は判定を何度も呼ぶので、
  // 外部リクエストの枠をそれだけで使い切りかねない
  const live = await fetchUsdJpy();
  if (live != null) await storeUsdJpy(live);
  return live;
}

/** 上限を設けていないときの判定（集計も為替も要らない）。 */
const NO_LIMIT: LimitVerdict = {
  blocked: false,
  reason: "no-limit",
  usedJpy: null,
  limitJpy: 0,
  estimated: false,
};

/**
 * 読み終えた設定・台帳・保存済みの為替から判定する。
 *
 * 生成の入口は、判定に要るものを会話や繋ぎ先と一緒に1つの batch で
 * 読む（readGenerationStart）。checkMonthlyLimit に任せるとそれを
 * もう一度 D1 から読み直し、送信から上流へ投げるまでの往復が増える。
 * 判定の中身を2か所に書かないよう、両方がここを通る。
 */
export async function monthlyLimitVerdict(
  loaded: {
    settings: AppSettings;
    usageTotals: UsageTotals;
    storedUsdJpy: number | null;
  },
  now = Date.now(),
  provisional: { points: number; costUsd: number | null } | null = null,
): Promise<LimitVerdict> {
  const { settings } = loaded;
  // 上限を設けていないなら、為替も要らない（外へ出ない）
  if (!(settings.monthlyLimitJpy > 0)) return { ...NO_LIMIT };
  return checkLimit({
    limitJpy: settings.monthlyLimitJpy,
    usdJpy: await rateForLimit(loaded.storedUsdJpy),
    totals: withProvisional(loaded.usageTotals, provisional),
    pointsUsdRate: settings.poePointsUsdRate,
    overrideMonth: settings.monthlyLimitOverride,
    now,
  });
}

/**
 * 今月の使用量が上限に達しているか（自分で読みに行く版。リトライ生成の
 * 発射ループが使う）。
 *
 * provisional は、まだ台帳に載っていないが使ったと分かっている消費
 * （Poe のリトライ生成が途中までに使ったポイント）。判定にだけ足す。
 */
export async function checkMonthlyLimit(
  now = Date.now(),
  provisional: { points: number; costUsd: number | null } | null = null,
): Promise<LimitVerdict> {
  const settings = await getAppSettings();
  // 上限を設けていないなら、集計も要らない
  if (!(settings.monthlyLimitJpy > 0)) return { ...NO_LIMIT };
  const [usageTotals, storedUsdJpy] = await Promise.all([
    usageTotalsSince(monthStartJst(now)),
    readStoredUsdJpy(),
  ]);
  return monthlyLimitVerdict(
    { settings, usageTotals, storedUsdJpy },
    now,
    provisional,
  );
}

/** 止めたときに画面へ出す文言。 */
export function limitMessage(v: LimitVerdict): string {
  const used = v.usedJpy != null ? `約${Math.round(v.usedJpy)}円` : "不明";
  return (
    `今月の使用額が上限に達しました（${used} / 上限 ${v.limitJpy}円）。` +
    `設定画面から上限を変えるか、今月だけ一時解除できます。`
  );
}
