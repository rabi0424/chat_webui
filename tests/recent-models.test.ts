import { beforeEach, describe, expect, it } from "vitest";
import { rankedModelIds, recordModelUse } from "../app/lib/recent-models";

/**
 * モデルピッカーの「最近よく使う」順。
 * localStorage を読み書きするので、壊れた値でも落ちないことを見る。
 */
const KEY = "chat-webui:model-use";

beforeEach(() => {
  localStorage.clear();
});

describe("rankedModelIds", () => {
  it("記録が無ければ空", () => {
    expect(rankedModelIds()).toEqual([]);
  });

  it("使った回数が多いモデルほど前に来る", () => {
    const now = Date.now();
    recordModelUse("よく使う", now);
    recordModelUse("よく使う", now);
    recordModelUse("よく使う", now);
    recordModelUse("たまに", now);
    expect(rankedModelIds(now)[0]).toBe("よく使う");
  });

  it("最近使ったほうが優先される", () => {
    const now = Date.now();
    const long = 60 * 24 * 60 * 60 * 1000;
    recordModelUse("昔よく使った", now - long);
    recordModelUse("昔よく使った", now - long);
    recordModelUse("昔よく使った", now - long);
    recordModelUse("さっき使った", now);
    expect(rankedModelIds(now)[0]).toBe("さっき使った");
  });

  it("保存が壊れていても落ちない", () => {
    for (const bad of ["{", "null", "[]", '"文字列"', "123"]) {
      localStorage.setItem(KEY, bad);
      expect(() => rankedModelIds(), bad).not.toThrow();
      expect(rankedModelIds(), bad).toEqual([]);
    }
  });

  it("壊れた保存のうえに記録しても落ちない", () => {
    localStorage.setItem(KEY, "壊れたJSON{{{");
    expect(() => recordModelUse("m1")).not.toThrow();
    expect(rankedModelIds()).toContain("m1");
  });
});
