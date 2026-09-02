/**
 * 会話一覧の日付グループ（今日・昨日・過去7日・過去30日・それ以前）。
 *
 * 一覧は最終更新順に並んでいるが、いつのものかは行から読めなかった。
 * 並びは変えず、見出しを挟んで地図を作る。
 *
 * 日の境は **JST** で切る。端末の時刻帯ではなく固定なのは、使用量の
 * 「今日」「今月」と同じ理由——同じ会話が端末によって別のグループに
 * 入ると、Mac と iPhone で見比べたときに位置がずれる。
 */

export type DateGroup = "today" | "yesterday" | "week" | "month" | "older";

export const DATE_GROUP_LABELS: Record<DateGroup, string> = {
  today: "今日",
  yesterday: "昨日",
  week: "過去7日",
  month: "過去30日",
  older: "それ以前",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** その時刻を含む JST の日の始まり（UTC のミリ秒）。 */
export function startOfDayJst(at: number): number {
  return Math.floor((at + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
}

/**
 * どのグループに入るか。
 *
 * 「過去7日」は今日を含めて7暦日（今日と昨日を除いた残りの5日ぶん）、
 * 「過去30日」は同じく30暦日。未来の時刻（端末の時計がずれている）は
 * 今日に入れる。
 */
export function dateGroupOf(at: number, now: number): DateGroup {
  const today = startOfDayJst(now);
  if (at >= today) return "today";
  if (at >= today - DAY_MS) return "yesterday";
  if (at >= today - 6 * DAY_MS) return "week";
  if (at >= today - 29 * DAY_MS) return "month";
  return "older";
}

/**
 * 並びを保ったまま、グループごとにまとめる。
 *
 * 入力は新しい順を前提とするが、順序が乱れていても壊れない——同じ
 * グループが離れて2回出るだけで、行が消えることはない。
 */
export function groupByDate<T>(
  items: T[],
  at: (item: T) => number,
  now: number,
): { group: DateGroup; items: T[] }[] {
  const out: { group: DateGroup; items: T[] }[] = [];
  for (const item of items) {
    const group = dateGroupOf(at(item), now);
    const last = out[out.length - 1];
    if (last && last.group === group) last.items.push(item);
    else out.push({ group, items: [item] });
  }
  return out;
}
