import { describe, expect, it } from "vitest";
import {
  dateGroupOf,
  groupByDate,
  startOfDayJst,
} from "../app/lib/date-groups";

/**
 * サイドバーの日付グループ。
 *
 * 境界は JST の日付の変わり目。ここがずれると、同じ会話が端末や時刻に
 * よって別の見出しの下に出る。境界の1ミリ秒前後を両方入れて、
 * `<` と `<=` の取り違えを捕まえる。
 */

/** 2026-09-02 12:00 JST（= 03:00 UTC）。 */
const NOON = Date.UTC(2026, 8, 2, 3, 0, 0);
/** 2026-09-02 00:00 JST（= 前日 15:00 UTC）。 */
const TODAY = Date.UTC(2026, 8, 1, 15, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe("startOfDayJst", () => {
  it("JST の 0 時を返す（UTC の 15 時）", () => {
    expect(startOfDayJst(NOON)).toBe(TODAY);
  });

  it("JST の 0 時の 1 ミリ秒前は前の日", () => {
    expect(startOfDayJst(TODAY - 1)).toBe(TODAY - DAY);
    expect(startOfDayJst(TODAY)).toBe(TODAY);
  });
});

describe("dateGroupOf", () => {
  it("今日の 0 時ちょうどは今日、その 1 ミリ秒前は昨日", () => {
    expect(dateGroupOf(TODAY, NOON)).toBe("today");
    expect(dateGroupOf(TODAY - 1, NOON)).toBe("yesterday");
  });

  it("未来の時刻も今日に入れる（時計のずれで消えない）", () => {
    expect(dateGroupOf(NOON + DAY, NOON)).toBe("today");
  });

  it("昨日の 0 時は昨日、その 1 ミリ秒前は過去7日", () => {
    expect(dateGroupOf(TODAY - DAY, NOON)).toBe("yesterday");
    expect(dateGroupOf(TODAY - DAY - 1, NOON)).toBe("week");
  });

  it("過去7日は今日を含めて7暦日", () => {
    expect(dateGroupOf(TODAY - 6 * DAY, NOON)).toBe("week");
    expect(dateGroupOf(TODAY - 6 * DAY - 1, NOON)).toBe("month");
  });

  it("過去30日は今日を含めて30暦日", () => {
    expect(dateGroupOf(TODAY - 29 * DAY, NOON)).toBe("month");
    expect(dateGroupOf(TODAY - 29 * DAY - 1, NOON)).toBe("older");
  });
});

describe("groupByDate", () => {
  it("並びを保ったまま見出しごとにまとめる", () => {
    const items = [
      { t: NOON - 1000 },
      { t: TODAY + 1 },
      { t: TODAY - DAY },
      { t: TODAY - 40 * DAY },
    ];
    expect(groupByDate(items, (x) => x.t, NOON)).toEqual([
      { group: "today", items: [items[0], items[1]] },
      { group: "yesterday", items: [items[2]] },
      { group: "older", items: [items[3]] },
    ]);
  });

  it("空なら空", () => {
    expect(groupByDate([], () => 0, NOON)).toEqual([]);
  });

  it("順序が乱れていても行は落ちない", () => {
    const items = [{ t: TODAY - DAY }, { t: NOON }, { t: TODAY - DAY }];
    const groups = groupByDate(items, (x) => x.t, NOON);
    expect(groups.flatMap((g) => g.items)).toEqual(items);
    expect(groups.map((g) => g.group)).toEqual(["yesterday", "today", "yesterday"]);
  });
});
