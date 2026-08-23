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

/**
 * その時刻が属する日の始まり（JST の 00:00）を epoch ms で返す。
 * 月の境界（monthStartJst）と同じ理由で、境界はここで数値にする。
 */
export function dayStartJst(now: number): number {
  const d = new Date(now + JST_OFFSET_MS);
  return (
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
    JST_OFFSET_MS
  );
}

/**
 * 使用量を見る期間。
 *
 * 「今日」と「今月」は暦の境界（JST）で切り、「直近7日」だけは
 * そこからの遡りで切る。週の初めを月曜とするか日曜とするかは
 * 決めの問題で、どちらにしても月初や週初は数字が急に小さくなる——
 * 見たいのは「このところどれだけ使っているか」なので、遡りのほうが
 * その問いに答える。
 */
export const USAGE_RANGES = ["day", "week", "month"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const USAGE_RANGE_LABELS: Record<UsageRange, string> = {
  day: "今日",
  week: "直近7日",
  month: "今月",
};

/** 直近◯日で切る期間の日数。 */
export const USAGE_WEEK_DAYS = 7;

/** その期間の始まり（epoch ms）。 */
export function usageRangeStart(range: UsageRange, now: number): number {
  if (range === "day") return dayStartJst(now);
  if (range === "week") return now - USAGE_WEEK_DAYS * 24 * 60 * 60 * 1000;
  return monthStartJst(now);
}

/**
 * 無料枠の目安（Cloudflare の公表値）。
 *
 * 使い切ると課金ではなく失敗になる（そういう契約で運用している。
 * 要件 §3.6 の運用面の前提を参照）ので、超える前に気づけるように
 * 割合で出す。**公表値は変わりうる**ので、画面でも「目安」と断る。
 */
export const FREE_TIER = {
  /** D1 のストレージ（無料プランのアカウント合計）。 */
  d1Bytes: 5 * 1024 ** 3,
  /** R2 の保存容量（月あたり）。 */
  r2Bytes: 10 * 1024 ** 3,
};

/** バイト数を読める単位にする。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // 1桁台は小数第1位まで（1GB と 1.5GB の差が潰れないように）
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
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
