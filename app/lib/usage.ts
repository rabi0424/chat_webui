/**
 * 使用量と月間上限の計算。
 *
 * DB にも fetch にも触らない純粋な計算だけを置く（サーバー・クライアント
 * 共用、テストしやすさのため）。実際の集計は db.server.ts、上限の判定を
 * 呼ぶのは生成の入口とリトライのループ。
 */

/** 日本標準時。夏時間が無いので固定の差で足りる。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * その時刻が属する月の始まり（JST の1日 00:00）を epoch ms で返す。
 *
 * SQLite 側で月を切ると、タイムゾーンの扱いが D1 の設定に左右される。
 * ここで境界を数値にしてしまい、クエリには `WHERE at >= ?` だけを渡す。
 */
export function monthStartJst(now: number): number {
  // JST の壁時計を UTC として読み、年と月だけ取り出す
  const d = new Date(now + JST_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - JST_OFFSET_MS;
}

/** その時刻が属する月の名前（"2026-08"）。一時解除の対象月に使う。 */
export function monthLabelJst(now: number): string {
  const d = new Date(now + JST_OFFSET_MS);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}`;
}

/** 期間の使用量。 */
export interface UsageTotals {
  /** ドル建ての額が取れた分の合計。 */
  costUsd: number;
  /** Poe のポイント合計（額が取れたものも含む、表示用）。 */
  points: number;
  /**
   * ドル建ての額が取れなかった分のポイント。
   *
   * Poe は応答に額を載せないので Usage API を照会するが、履歴への反映が
   * 間に合わないと取りこぼす。取りこぼした分を上限の計算から落とすと
   * 「使っているのに減らない」ことになるので、ここだけ別に数えて
   * 換算レートで見積もる。
   */
  pointsWithoutCost: number;
  /** 記録した件数。 */
  events: number;
}

export const EMPTY_TOTALS: UsageTotals = {
  costUsd: 0,
  points: 0,
  pointsWithoutCost: 0,
  events: 0,
};

/**
 * 上限の判定に使う実効ドル額。
 *
 * 実額 + 「額が取れなかったポイント × 換算レート」。レートが 0 なら
 * ポイント分は数えない（＝見積もりを混ぜたくないときの設定）。
 */
export function effectiveUsd(t: UsageTotals, pointsUsdRate: number): number {
  const est =
    pointsUsdRate > 0 ? t.pointsWithoutCost * pointsUsdRate : 0;
  return t.costUsd + est;
}

export interface LimitInput {
  /** 月間の上限（円）。0 以下なら上限なし。 */
  limitJpy: number;
  /** USD/JPY。取れていなければ null。 */
  usdJpy: number | null;
  totals: UsageTotals;
  /** ポイント1点あたりのドル。0 なら見積もらない。 */
  pointsUsdRate: number;
  /** 一時解除の対象月（"2026-08"）。当月と一致するあいだだけ効く。 */
  overrideMonth: string | null;
  now: number;
}

export type LimitVerdict = {
  blocked: boolean;
  /** 判定の根拠。画面の文言を選ぶのに使う。 */
  reason: "no-limit" | "under" | "over" | "override" | "no-rate";
  /** 今月の使用額（円）。レートが無ければ null。 */
  usedJpy: number | null;
  limitJpy: number;
  /** ポイントからの見積もりが混ざっているか。 */
  estimated: boolean;
};

/**
 * 今月の使用量が上限に達しているか。
 *
 * 為替レートが取れないときは**通す**。上限は課金事故を防ぐためのもので、
 * 無料の為替APIが落ちているあいだ生成そのものを止めてしまうと、
 * 防ぎたかった損害より大きな不便になる。判定できなかったことは
 * 画面に出して、黙って素通りさせない。
 */
export function checkLimit(input: LimitInput): LimitVerdict {
  const { limitJpy, usdJpy, totals, pointsUsdRate, overrideMonth, now } = input;
  const estimated = pointsUsdRate > 0 && totals.pointsWithoutCost > 0;
  const usedJpy =
    usdJpy != null ? effectiveUsd(totals, pointsUsdRate) * usdJpy : null;

  if (!(limitJpy > 0)) {
    return { blocked: false, reason: "no-limit", usedJpy, limitJpy, estimated };
  }
  if (overrideMonth != null && overrideMonth === monthLabelJst(now)) {
    return { blocked: false, reason: "override", usedJpy, limitJpy, estimated };
  }
  if (usedJpy == null) {
    return { blocked: false, reason: "no-rate", usedJpy, limitJpy, estimated };
  }
  return {
    blocked: usedJpy >= limitJpy,
    reason: usedJpy >= limitJpy ? "over" : "under",
    usedJpy,
    limitJpy,
    estimated,
  };
}
