import { beforeEach, describe, expect, it } from "vitest";
import {
  MODELS_CACHE_KEY,
  readCachedModels,
  writeCachedModels,
} from "../app/lib/model-cache";
import type { ModelInfo } from "../app/lib/openrouter.server";

/**
 * 起動を速くするための持ち越し。
 *
 * 中身は前のバージョンのアプリが書いたものかもしれず、手で書き換える
 * こともできる。使う側は `outputModalities.includes(...)` のように
 * **中の配列を前提に**しているので、形が違うとその場で例外になり、
 * 画面が丸ごと落ちる。表示が少し遅くなるより悪い。
 */
const model = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    description: "",
    contextLength: 1000,
    promptPrice: "0",
    completionPrice: "0",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedParameters: ["temperature"],
    provider: "openrouter",
    ...extra,
  }) as unknown as ModelInfo;

const put = (v: unknown) =>
  localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(v));

beforeEach(() => localStorage.clear());

describe("持ち越しの読み書き", () => {
  it("書いたものが読める", () => {
    writeCachedModels([model("a"), model("b")]);
    expect(readCachedModels().map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("何も無ければ空", () => {
    expect(readCachedModels()).toEqual([]);
  });
});

describe("壊れた持ち越し", () => {
  it("JSONとして読めなければ空", () => {
    localStorage.setItem(MODELS_CACHE_KEY, "{壊れている");
    expect(readCachedModels()).toEqual([]);
  });

  it("配列でなければ空", () => {
    put({ models: [] });
    expect(readCachedModels()).toEqual([]);
  });

  it("配列の中身が全部おかしければ空", () => {
    put([1, "a", null, {}]);
    expect(readCachedModels()).toEqual([]);
  });

  /** これが落ちる原因だったところ。 */
  it("配列であるべき項目が無いものは落とす", () => {
    put([model("よい"), { id: "わるい", name: "わるい" }]);
    expect(readCachedModels().map((m) => m.id)).toEqual(["よい"]);
  });

  it("配列だが中身が文字列でないものも落とす", () => {
    put([model("よい"), model("わるい", { outputModalities: [1, 2] })]);
    expect(readCachedModels().map((m) => m.id)).toEqual(["よい"]);
  });

  it("id が空のものは落とす", () => {
    put([model("よい"), model("")]);
    expect(readCachedModels().map((m) => m.id)).toEqual(["よい"]);
  });

  /**
   * 1件の壊れで全部捨てると、起動の速さを毎回失う。
   * 使えるものは使う。
   */
  it("よいものだけ残す", () => {
    put([model("a"), null, model("b"), { id: "c" }, model("d")]);
    expect(readCachedModels().map((m) => m.id)).toEqual(["a", "b", "d"]);
  });

  it("読んだものは、そのまま使っても落ちない", () => {
    put([model("a"), { id: "こわれ" }]);
    for (const m of readCachedModels()) {
      // 使う側と同じ触り方
      expect(() => m.outputModalities.includes("image")).not.toThrow();
      expect(() => m.supportedParameters.includes("tools")).not.toThrow();
    }
  });
});
