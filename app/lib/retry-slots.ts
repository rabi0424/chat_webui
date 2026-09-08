/**
 * スマート生成: 「成功するまで生成」で、いま開けておく枠の数を決める。
 *
 * 並列数を固定にすると、目標に届く手前で走っていた分が全部成功したとき
 * 目標を大きく超え、超過分がそのまま課金される。枠の数を成功率から
 * 決め直せば、通りやすいときは絞り、通りにくいときだけ増やせる。
 *
 * 成功率は**この実行の中の成功と失敗だけ**から見積もる（同じプロンプト・
 * 同じ生成設定で投げた試行だけが同じ率に従うため。実行ごとに仕切り直す）。
 *
 * 決め方は、利用者が入れた割合 n% を2回使う。
 *
 * 1. これまでの観測（試行 a 回・成功 s 回）は、本当の成功率 p に対して
 *    **下位 n% のはずれ**だったと見なす。つまり「p のもとで成功が s 回
 *    以下になる確率がちょうど n%」となる p を本当の率とする（二項分布の
 *    片側上限）。失敗続きの最中に見えている率は本来より低く出ているので、
 *    それを真に受けて枠を増やすと、次の一束は本来の率で返ってきて成功が
 *    想定より多く届く。この上限を使うのは、その分を先に見越すため。
 * 2. 次に投げる k 本は**上位 n% のあたり**になると見なす。つまり k 本の
 *    成功数が上位 n% の値でも残りの目標を超えないような、最大の k を
 *    開ける。式では「p のもとで k 本の成功が残りを超える確率が n% 以下」。
 *
 * どちらも枠を絞る向きに働く。誤る向きは「枠が足りない」側に倒す。
 * 足りなければ遅くなるだけで課金は増えない。多すぎると超過分が課金される。
 *
 * 試行がまだ少ないうちは、観測が少なすぎて上限がほとんど動かない
 * （0/3 でも 0/0 でも「率は高いかもしれない」としか言えない）。そのあいだ
 * は統計に頼らず、枠を残りの目標数までにして目標を超えないようにする。
 * 溜まってきたら上の決め方へ移る。
 */

/** 統計へ移るまでに溜める試行の数。ここまでは目標を超える枠を開けない。 */
export const RETRY_SMART_WARMUP_ATTEMPTS = 10;

export const RETRY_SMART_DEFAULT_PERCENT = 10;
export const RETRY_SMART_MIN_PERCENT = 1;
export const RETRY_SMART_MAX_PERCENT = 50;

/** log(k!) を 0..n まで。二項係数を桁あふれなしで出すため。 */
function logFactorials(n: number): number[] {
  const lf = new Array<number>(n + 1);
  lf[0] = 0;
  for (let i = 1; i <= n; i++) lf[i] = lf[i - 1] + Math.log(i);
  return lf;
}

/** X ~ Bin(n, p) について P(X ≤ s)。 */
export function binomialCdf(s: number, n: number, p: number): number {
  if (s < 0) return 0;
  if (s >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lf = logFactorials(n);
  const lp = Math.log(p);
  const lq = Math.log(1 - p);
  let sum = 0;
  for (let k = 0; k <= s; k++) {
    sum += Math.exp(lf[n] - lf[k] - lf[n - k] + k * lp + (n - k) * lq);
  }
  return Math.min(1, sum);
}

/**
 * 観測が「下位 percent% のはずれ」だったとしたときの本当の成功率。
 * P(X ≤ successes | attempts, p) = percent/100 となる p。
 *
 * P(X ≤ s) は p について単調に減るので二分法で求まる。全部成功なら 1。
 */
export function upperSuccessRate(input: {
  successes: number;
  attempts: number;
  percent: number;
}): number {
  const { successes, attempts } = input;
  if (attempts <= 0 || successes >= attempts) return 1;
  const alpha = input.percent / 100;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(successes, attempts, mid) >= alpha) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface RetrySlotInput {
  /** ほしい成功の数。 */
  target: number;
  /** この実行で得た成功の数。 */
  successes: number;
  /** この実行で消費した試行の数（成功＋失敗。レート制限は含めない）。 */
  attempts: number;
  /** あきらめるまでの試行回数。 */
  maxAttempts: number;
  /** 利用者が決めた並列数の上限。これを超えて枠は開けない。 */
  cap: number;
  /** はずれ／あたりと見なす割合（%）。 */
  percent: number;
}

/**
 * いま開けておく枠の数（走っている本数を含めた本数）。
 *
 * 呼び出し側は「走っている本数がこれより少ないあいだ発射する」と読む。
 * 走っている分の結果が返るたびに数え直すので、成功が届けば枠は自然に
 * 縮み、失敗が続けば少しずつ広がる。
 */
export function planRetrySlots(input: RetrySlotInput): number {
  const remaining = input.target - input.successes;
  if (remaining <= 0) return 0;
  const budget = Math.min(input.cap, input.maxAttempts - input.attempts);
  if (budget <= 0) return 0;

  // 溜まるまでは目標を超える枠を開けない
  let k = Math.min(remaining, budget);
  if (input.attempts < RETRY_SMART_WARMUP_ATTEMPTS) return k;

  const p = upperSuccessRate(input);
  const alpha = input.percent / 100;
  // 超える確率は k について単調に増えるので、許せるあいだ1本ずつ足す
  while (k < budget && 1 - binomialCdf(remaining, k + 1, p) <= alpha) k++;
  return k;
}
