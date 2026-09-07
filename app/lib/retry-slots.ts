/**
 * スマート連続生成: 「成功するまで生成」で、いま開けておく枠の数を決める。
 *
 * 並列数を固定にすると、目標に届く手前で走っていた分が全部成功したとき
 * 目標を大きく超え、超過分がそのまま課金される。枠の数を「残りの目標 ÷
 * 次の試行の成功率の見込み」で決め直せば、見込みが高いときは絞り、低い
 * ときだけ増やせる。
 *
 * 成功率は**この実行の中の成功と失敗だけ**から見積もる（同じプロンプト・
 * 同じ生成設定で投げた試行だけが同じ率に従うため。実行ごとに仕切り直す）。
 *
 * ただし観測した率をそのまま使ってはならない。枠を増やしたくなるのは
 * 失敗が続いているときで、そのときに見えている率は本来の率より**低く**
 * 出ている（下振れの最中）。それを真に受けて枠を増やすと、次の一束は
 * 本来の率で返ってくるので成功が想定より多く、超過分が課金される。
 * つまり、増やす判断の直前は過小評価、増やした直後は過大評価になる。
 * これを見越して、見積もりには**まだ見えていない成功を数本ぶん上乗せ**
 * する。失敗が積もるほど上乗せの影響は薄れ、観測した率へ近づく。
 *
 * 誤る向きは「枠が足りない」側へ倒す。足りなければ遅くなるだけで課金は
 * 増えない。多すぎると超過分が課金される。
 */

/** 見えている成功に上乗せする、まだ見えていない成功の見込み本数。 */
export const RETRY_SLOT_OPTIMISM = 2;

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
}

/**
 * 次の試行の成功率の見込み。0 より大きく 1 以下。
 *
 * 成功も試行も無い最初は 1 とみなす（残りの目標と同じ本数だけ開ける）。
 */
export function estimateSuccessRate(input: {
  successes: number;
  attempts: number;
}): number {
  return (
    (input.successes + RETRY_SLOT_OPTIMISM) /
    (input.attempts + RETRY_SLOT_OPTIMISM)
  );
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
  const rate = estimateSuccessRate(input);
  const wanted = Math.ceil(remaining / rate);
  return Math.max(
    0,
    Math.min(wanted, input.cap, input.maxAttempts - input.attempts),
  );
}
