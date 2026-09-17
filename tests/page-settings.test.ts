import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_SETTINGS,
  PAGE_MAX_CHARS_RANGE,
  PAGE_MAX_MB_RANGE,
  PAGE_MAX_PAGES_RANGE,
  PAGE_TIMEOUT_RANGE,
  clampPageSettings,
} from "../app/lib/settings";

/**
 * 取り込みの上限の保存。
 *
 * 範囲を外れた値がそのまま入ると、**画面には何も出ないまま**壊れる
 * ——0字で取り込む（本文が空のページを渡す）、1000MBを読みに行く、
 * 0秒で諦める。設定画面は範囲を出しているが、そこを通らない要求
 * （直に PATCH を投げる・古い画面）でも同じように止める。
 */
const base = DEFAULT_APP_SETTINGS;

describe("上限の保存", () => {
  it("渡された項目だけを書き換える", () => {
    expect(clampPageSettings(base, { pageMaxPages: 3 })).toEqual({
      pageMaxPages: 3,
      pageMaxChars: base.pageMaxChars,
      pageMaxMb: base.pageMaxMb,
      pageTimeoutSec: base.pageTimeoutSec,
    });
  });

  it("範囲の外は端に寄せる", () => {
    const out = clampPageSettings(base, {
      pageMaxPages: 999,
      pageMaxChars: 1,
      pageMaxMb: 0,
      pageTimeoutSec: 10_000,
    });
    expect(out.pageMaxPages).toBe(PAGE_MAX_PAGES_RANGE.max);
    expect(out.pageMaxChars).toBe(PAGE_MAX_CHARS_RANGE.min);
    expect(out.pageMaxMb).toBe(PAGE_MAX_MB_RANGE.min);
    expect(out.pageTimeoutSec).toBe(PAGE_TIMEOUT_RANGE.max);
  });

  /** 0 は「取り込まない」という意味を持つので、本数だけは通す。 */
  it("本数の 0 は通す（取り込まない）", () => {
    expect(clampPageSettings(base, { pageMaxPages: 0 }).pageMaxPages).toBe(0);
    // 長さ・大きさ・秒数の 0 は「何もできない値」なので下限へ寄せる
    expect(clampPageSettings(base, { pageMaxChars: 0 }).pageMaxChars).toBe(
      PAGE_MAX_CHARS_RANGE.min,
    );
    expect(clampPageSettings(base, { pageTimeoutSec: 0 }).pageTimeoutSec).toBe(
      PAGE_TIMEOUT_RANGE.min,
    );
  });

  /**
   * 壊れた値で現在値を捨てない。「送られてこなかった項目」と同じ扱いに
   * しないと、1項目を保存しただけで他の項目が黙って巻き戻る。
   */
  it("数として読めない値は、いまの値のまま", () => {
    const current = { ...base, pageMaxPages: 3, pageMaxChars: 12_000 };
    const out = clampPageSettings(current, {
      pageMaxPages: "たくさん" as unknown as number,
      pageMaxChars: Number.NaN,
    });
    expect(out.pageMaxPages).toBe(3);
    expect(out.pageMaxChars).toBe(12_000);
  });

  it("小数は丸める", () => {
    expect(clampPageSettings(base, { pageMaxPages: 2.6 }).pageMaxPages).toBe(3);
  });
});
