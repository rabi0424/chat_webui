import { describe, expect, it } from "vitest";
import {
  EMPTY_TOTALS,
  USAGE_WEEK_DAYS,
  budgetPace,
  checkLimit,
  dayStartJst,
  effectiveUsd,
  formatBytes,
  monthEndJst,
  monthLabelJst,
  monthStartJst,
  usageRangeStart,
  withProvisional,
  type UsageTotals,
} from "../app/lib/usage";

/**
 * 使用量と月間上限。
 *
 * 月の区切りは JST。UTC で切ると、月初の9時間ぶんが前の月に数えられ、
 * 「月が変わったのに上限が解けない」ことになる。
 */
const totals = (p: Partial<UsageTotals> = {}): UsageTotals => ({
  ...EMPTY_TOTALS,
  ...p,
});

/** JST の時刻を epoch ms に。 */
const jst = (s: string) => Date.parse(`${s}+09:00`);

describe("月の区切り", () => {
  it("JST の1日 00:00 で切る", () => {
    const start = monthStartJst(jst("2026-08-21T12:00:00"));
    expect(start).toBe(jst("2026-08-01T00:00:00"));
  });

  it("月初の午前0時ちょうどは、その月に入る", () => {
    const t = jst("2026-08-01T00:00:00");
    expect(monthStartJst(t)).toBe(t);
  });

  it("月初の午前8時は前の月に落ちない（UTCで切ると落ちる）", () => {
    // UTC では 2026-07-31T23:00Z。素朴に UTC で切ると7月扱いになる
    const t = jst("2026-08-01T08:00:00");
    expect(monthStartJst(t)).toBe(jst("2026-08-01T00:00:00"));
    expect(monthLabelJst(t)).toBe("2026-08");
  });

  it("月末の23時台はまだその月", () => {
    const t = jst("2026-08-31T23:30:00");
    expect(monthStartJst(t)).toBe(jst("2026-08-01T00:00:00"));
    expect(monthLabelJst(t)).toBe("2026-08");
  });

  it("年をまたぐ", () => {
    const t = jst("2026-01-05T10:00:00");
    expect(monthStartJst(t)).toBe(jst("2026-01-01T00:00:00"));
    expect(monthLabelJst(t)).toBe("2026-01");
  });
});

describe("実効額", () => {
  it("額が取れている分はそのまま足す", () => {
    expect(effectiveUsd(totals({ costUsd: 1.5 }), 0.001)).toBeCloseTo(1.5);
  });

  it("額が取れなかったポイントは、レートで見積もって足す", () => {
    const t = totals({ costUsd: 1, points: 3000, pointsWithoutCost: 2000 });
    expect(effectiveUsd(t, 0.0005)).toBeCloseTo(1 + 1);
  });

  it("レートが0なら、ポイント分は数えない", () => {
    const t = totals({ costUsd: 1, pointsWithoutCost: 2000 });
    expect(effectiveUsd(t, 0)).toBeCloseTo(1);
  });
});

describe("上限の判定", () => {
  const base = {
    usdJpy: 150,
    pointsUsdRate: 0,
    overrideMonth: null,
    now: jst("2026-08-21T12:00:00"),
  };

  it("上限が0なら止めない", () => {
    const v = checkLimit({ ...base, limitJpy: 0, totals: totals({ costUsd: 99 }) });
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe("no-limit");
  });

  it("下回っていれば通す", () => {
    const v = checkLimit({ ...base, limitJpy: 500, totals: totals({ costUsd: 1 }) });
    expect(v.blocked).toBe(false);
    expect(v.usedJpy).toBeCloseTo(150);
  });

  it("超えたら止める", () => {
    const v = checkLimit({ ...base, limitJpy: 500, totals: totals({ costUsd: 4 }) });
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("over");
  });

  it("ちょうど上限でも止める", () => {
    const v = checkLimit({
      ...base,
      limitJpy: 500,
      totals: totals({ costUsd: 500 / 150 }),
    });
    expect(v.blocked).toBe(true);
  });

  it("当月の一時解除が効いているあいだは通す", () => {
    const v = checkLimit({
      ...base,
      limitJpy: 500,
      totals: totals({ costUsd: 99 }),
      overrideMonth: "2026-08",
    });
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe("override");
  });

  it("先月の一時解除は効かない", () => {
    const v = checkLimit({
      ...base,
      limitJpy: 500,
      totals: totals({ costUsd: 99 }),
      overrideMonth: "2026-07",
    });
    expect(v.blocked).toBe(true);
  });

  it("為替が取れないときは通す（黙って止めない）", () => {
    const v = checkLimit({
      ...base,
      usdJpy: null,
      limitJpy: 500,
      totals: totals({ costUsd: 99 }),
    });
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe("no-rate");
    expect(v.usedJpy).toBeNull();
  });

  it("ポイントの見積もりが混ざったら、そう分かる", () => {
    const v = checkLimit({
      ...base,
      limitJpy: 500,
      pointsUsdRate: 0.0005,
      totals: totals({ pointsWithoutCost: 2000 }),
    });
    expect(v.estimated).toBe(true);
    expect(v.usedJpy).toBeCloseTo(150);
  });

  it("見積もったポイントだけでも上限に達する", () => {
    const v = checkLimit({
      ...base,
      limitJpy: 500,
      pointsUsdRate: 0.0005,
      totals: totals({ pointsWithoutCost: 8000 }),
    });
    expect(v.blocked).toBe(true);
  });
});

/**
 * 期間の切り替え（今日 / 直近7日 / 今月）。
 *
 * 「今日」も月と同じく JST の暦で切る。UTC で切ると、日本時間の朝は
 * 前の日に数えられ、朝いちばんに開くと**昨日の分が今日として**出る。
 */
describe("期間の切り方", () => {
  it("今日は JST の 00:00 から", () => {
    expect(dayStartJst(jst("2026-08-21T12:34:56"))).toBe(
      jst("2026-08-21T00:00:00"),
    );
  });

  it("日本時間の朝8時は、前の日に落ちない（UTCで切ると落ちる）", () => {
    // UTC では 2026-08-20T23:00Z。素朴に UTC で切ると20日扱いになる
    const t = jst("2026-08-21T08:00:00");
    expect(dayStartJst(t)).toBe(jst("2026-08-21T00:00:00"));
  });

  it("期間ごとに始まりが変わる", () => {
    const now = jst("2026-08-21T12:00:00");
    expect(usageRangeStart("day", now)).toBe(jst("2026-08-21T00:00:00"));
    expect(usageRangeStart("month", now)).toBe(jst("2026-08-01T00:00:00"));
    // 直近7日だけは暦ではなく、そこからの遡り
    expect(usageRangeStart("week", now)).toBe(
      now - USAGE_WEEK_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it("狭い期間ほど、始まりが後になる", () => {
    // 月初は「今月」が「直近7日」より後になりうるので、月の途中で見る
    const now = jst("2026-08-21T12:00:00");
    expect(usageRangeStart("day", now)).toBeGreaterThan(
      usageRangeStart("week", now),
    );
    expect(usageRangeStart("week", now)).toBeGreaterThan(
      usageRangeStart("month", now),
    );
  });
});

/** 保管しているものの大きさの表示。 */
describe("バイト数の表示", () => {
  it("単位が繰り上がる", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3 GB");
  });

  it("1桁台は小数第1位まで残す（1.5GBと1GBの差を潰さない）", () => {
    expect(formatBytes(Math.round(1.5 * 1024 ** 3))).toBe("1.5 GB");
    expect(formatBytes(Math.round(4.2 * 1024 ** 2))).toBe("4.2 MB");
    // 2桁になれば丸める（小数は要らない大きさ）
    expect(formatBytes(Math.round(12.4 * 1024 ** 2))).toBe("12 MB");
  });

  it("1未満になる単位へは繰り上げない", () => {
    // 0.9GB は「922 MB」。単位のほうを下げて、0.x を出さない
    expect(formatBytes(Math.round(0.9 * 1024 ** 3))).toBe("922 MB");
  });

  it("取れなかったときは数字を作らない", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(0)).toBe("0 B");
  });
});

/**
 * 台帳に載る前の消費を判定に足す。Poe のリトライ生成は消費が最後に
 * まとめて載るので、走っているあいだ月間上限が実行全体を素通しにしていた。
 */
describe("仮の消費を足す", () => {
  const base: UsageTotals = {
    ...EMPTY_TOTALS,
    costUsd: 1,
    points: 100,
    pointsWithoutCost: 50,
  };

  it("額が取れていれば額に、ポイントは表示用の合計にだけ足す", () => {
    const t = withProvisional(base, { points: 300, costUsd: 0.5 });
    expect(t.costUsd).toBeCloseTo(1.5, 10);
    expect(t.points).toBe(400);
    expect(t.pointsWithoutCost).toBe(50);
    // 判定に使う実効額に反映される
    expect(effectiveUsd(t, 0.001)).toBeCloseTo(1.5 + 50 * 0.001, 10);
  });

  it("額が無ければ「額の無いポイント」として足し、レートで見積もる", () => {
    const t = withProvisional(base, { points: 300, costUsd: null });
    expect(t.costUsd).toBe(1);
    expect(t.points).toBe(400);
    expect(t.pointsWithoutCost).toBe(350);
    expect(effectiveUsd(t, 0.001)).toBeCloseTo(1 + 350 * 0.001, 10);
  });

  it("無ければ何も変えない（同じオブジェクトを返す）", () => {
    expect(withProvisional(base, null)).toBe(base);
    expect(withProvisional(base, { points: 0, costUsd: null })).toBe(base);
    expect(withProvisional(base, { points: 0, costUsd: 0 })).toBe(base);
  });
});

/**
 * 消化ペース（完全比例ならいまここ、という地点）。
 *
 * 「上限の何割を使ったか」だけでは速いのか遅いのか分からない。月末の
 * 80% と3日目の 80% は意味が違う。ここで見るのは、**時刻まで含めた**
 * 経過割合と、月の長さの取り方（日数ではなく実長）。
 */
describe("消化ペース", () => {
  it("経過は時刻まで数える（日で切ると昼と夜が同じ地点になる）", () => {
    // 8月（31日）の16日 12:00 はちょうど半月。日で切ると 15/31 になる
    const pace = budgetPace({
      usedJpy: 0,
      limitJpy: 3100,
      now: jst("2026-08-16T12:00:00"),
    })!;
    expect(pace.elapsed).toBeCloseTo(0.5, 12);
    expect(pace.paceJpy).toBeCloseTo(1550, 9);
  });

  it("月の長さは実長で割る（2月と8月で1日の重みが変わる）", () => {
    // 2月（28日）の15日 0:00 は 14/28 = ちょうど半月
    const feb = budgetPace({
      usedJpy: 0,
      limitJpy: 2800,
      now: jst("2026-02-15T00:00:00"),
    })!;
    expect(feb.elapsed).toBeCloseTo(0.5, 12);
    // 同じ日でも8月（31日）では半分に届かない
    const aug = budgetPace({
      usedJpy: 0,
      limitJpy: 2800,
      now: jst("2026-08-15T00:00:00"),
    })!;
    expect(aug.elapsed).toBeCloseTo(14 / 31, 12);
  });

  it("月の境界は JST（UTC で切ると月初の9時間が前の月に落ちる）", () => {
    // UTC では 2026-08-31T15:30Z。9月（30日）の 0.5 時間ぶんだけ進んでいる
    const pace = budgetPace({
      usedJpy: 0,
      limitJpy: 3000,
      now: jst("2026-09-01T00:30:00"),
    })!;
    expect(pace.elapsed).toBeCloseTo(0.5 / (30 * 24), 12);
    expect(monthEndJst(jst("2026-09-01T00:30:00"))).toBe(
      jst("2026-10-01T00:00:00"),
    );
  });

  it("目安との差と、速い / 予定どおり / 控えめの見立て", () => {
    // 8/16 12:00 ＝ 半月。上限 3100 の目安は 1550
    const at = (usedJpy: number) =>
      budgetPace({ usedJpy, limitJpy: 3100, now: jst("2026-08-16T12:00:00") })!;
    expect(at(2000).diffJpy).toBeCloseTo(450, 9);
    expect(at(2000).tone).toBe("fast");
    expect(at(1000).diffJpy).toBeCloseTo(-550, 9);
    expect(at(1000).tone).toBe("slow");
    // ±5% の幅の中は「ほぼ予定どおり」。幅が無いと数円で見立てが裏返る
    expect(at(1550).tone).toBe("on");
    expect(at(1550 * 1.04).tone).toBe("on");
    expect(at(1550 * 1.06).tone).toBe("fast");
    expect(at(1550 * 0.96).tone).toBe("on");
    expect(at(1550 * 0.94).tone).toBe("slow");
  });

  it("このペースのまま進んだときの月末の額を出す", () => {
    // 半月で 2000 円 → 月末は 4000 円
    const pace = budgetPace({
      usedJpy: 2000,
      limitJpy: 3100,
      now: jst("2026-08-16T12:00:00"),
    })!;
    expect(pace.projectedJpy).toBeCloseTo(4000, 9);
  });

  it("1日ぶんも経っていないうちは月末の見込みを出さない", () => {
    // 分母（経過割合）が小さいあいだは、1件の生成で月末の数字が跳ねる
    const young = budgetPace({
      usedJpy: 100,
      limitJpy: 3100,
      now: jst("2026-08-01T06:00:00"),
    })!;
    expect(young.projectedJpy).toBeNull();
    // 目安そのもの（印を置く地点）は最初から出る
    expect(young.elapsed).toBeCloseTo(6 / (31 * 24), 12);
    const grown = budgetPace({
      usedJpy: 100,
      limitJpy: 3100,
      now: jst("2026-08-02T00:00:00"),
    })!;
    expect(grown.projectedJpy).toBeCloseTo(3100, 9);
  });

  it("上限が無い / 月初の0時ちょうどなら、比べる相手が無いので出さない", () => {
    const now = jst("2026-08-16T12:00:00");
    expect(budgetPace({ usedJpy: 100, limitJpy: 0, now })).toBeNull();
    expect(
      budgetPace({
        usedJpy: 100,
        limitJpy: 3100,
        now: jst("2026-08-01T00:00:00"),
      }),
    ).toBeNull();
  });
});
