import { describe, expect, it } from "vitest";
import {
  buildGenerationPayload,
  parseParamsJson,
  PARAM_DEFS,
  POE_EXTRA_PREFIX,
  POE_REASONING_EFFORT_KEY,
  POE_THINKING_BUDGET_KEY,
  REASONING_KEY,
} from "../app/lib/params";

/**
 * 生成パラメータの組み立て。
 *
 * ここが崩れると、上流が 400 を返して生成そのものが失敗する（利用者には
 * 英語のエラーだけが見える）。プロバイダごとに置き場所も検証も違うので、
 * 「送ってよい形になっているか」を境界値で押さえる。
 */
describe("buildGenerationPayload（共通）", () => {
  it("設定が無ければ何も送らない", () => {
    expect(buildGenerationPayload(null)).toEqual({});
    expect(buildGenerationPayload(undefined)).toEqual({});
    expect(buildGenerationPayload({})).toEqual({});
  });

  it("オブジェクト以外を渡されても壊れない", () => {
    for (const bad of ["文字列", 42, true, []]) {
      expect(() => buildGenerationPayload(bad as never)).not.toThrow();
    }
  });
});

describe("buildGenerationPayload（OpenRouter）", () => {
  it("数値は定義された範囲に収めて送る", () => {
    // 保存済みの設定に範囲外の値が残っていると上流が400を返す
    const out = buildGenerationPayload({ temperature: 99, top_p: -5 });
    expect(out.temperature).toBe(2);
    expect(out.top_p).toBe(0);
  });

  it("すべての数値パラメータが範囲内に収まる", () => {
    for (const def of PARAM_DEFS) {
      if (def.kind !== "number") continue;
      for (const raw of [-1e9, 1e9, def.min - 1, def.max + 1]) {
        const out = buildGenerationPayload({ [def.key]: raw });
        const v = out[def.key] as number;
        expect(v, `${def.key} に ${raw} を渡したとき`).toBeGreaterThanOrEqual(def.min);
        expect(v, `${def.key} に ${raw} を渡したとき`).toBeLessThanOrEqual(def.max);
      }
    }
  });

  it("整数指定のパラメータは丸めて送る", () => {
    for (const def of PARAM_DEFS) {
      if (def.kind !== "number" || !def.integer) continue;
      const out = buildGenerationPayload({ [def.key]: def.min + 0.4 });
      expect(Number.isInteger(out[def.key])).toBe(true);
    }
  });

  it("数値にならない値は送らない（キーごと落とす）", () => {
    for (const bad of ["abc", "", NaN, Infinity, -Infinity]) {
      const out = buildGenerationPayload({ temperature: bad as never });
      expect(out).not.toHaveProperty("temperature");
    }
  });

  it("思考の指定はAPIの形へ移す", () => {
    expect(buildGenerationPayload({ [REASONING_KEY]: "off" }).reasoning).toEqual({
      enabled: false,
    });
    expect(buildGenerationPayload({ [REASONING_KEY]: "high" }).reasoning).toEqual({
      effort: "high",
    });
  });

  it("知らない選択肢は送らない", () => {
    expect(buildGenerationPayload({ [REASONING_KEY]: "ultra" })).not.toHaveProperty(
      "reasoning",
    );
  });

  it("停止文字列はカンマ区切りを配列にし、4件までに切る", () => {
    expect(buildGenerationPayload({ stop: "a, b ,c" }).stop).toEqual(["a", "b", "c"]);
    expect(buildGenerationPayload({ stop: "1,2,3,4,5,6" }).stop).toHaveLength(4);
    expect(buildGenerationPayload({ stop: " , , " })).not.toHaveProperty("stop");
  });

  it("Poe専用の項目はOpenRouterへ混ぜない", () => {
    const out = buildGenerationPayload({
      [POE_THINKING_BUDGET_KEY]: 1000,
      [`${POE_EXTRA_PREFIX}aspect_ratio`]: "16:9",
    });
    expect(out).not.toHaveProperty(POE_THINKING_BUDGET_KEY);
    expect(out).not.toHaveProperty("extra_body");
  });
});

describe("buildGenerationPayload（Poe）", () => {
  const poe = (state: Record<string, number | string>) =>
    buildGenerationPayload(state, "poe");

  it("temperature は 0〜2 に収める", () => {
    expect(poe({ temperature: 5 }).temperature).toBe(2);
    expect(poe({ temperature: -1 }).temperature).toBe(0);
  });

  it("ボット独自パラメータは extra_body に入れる", () => {
    // ボディ直下へ置くと未知フィールドとして400になる
    const out = poe({ [`${POE_EXTRA_PREFIX}aspect_ratio`]: "16:9" });
    expect(out.extra_body).toEqual({ aspect_ratio: "16:9" });
    expect(out).not.toHaveProperty("aspect_ratio");
  });

  it("独自パラメータの値は見たままの型へ寄せる", () => {
    const out = poe({
      [`${POE_EXTRA_PREFIX}web_search`]: "true",
      [`${POE_EXTRA_PREFIX}steps`]: "30",
      [`${POE_EXTRA_PREFIX}ratio`]: "16:9",
      [`${POE_EXTRA_PREFIX}scale`]: "1.5",
    });
    expect(out.extra_body).toEqual({
      web_search: true,
      steps: 30,
      // "16:9" を数値扱いすると比率が壊れる
      ratio: "16:9",
      scale: 1.5,
    });
  });

  it("名前として通らない独自パラメータは捨てる", () => {
    const out = poe({
      [`${POE_EXTRA_PREFIX}9lives`]: "x",
      [`${POE_EXTRA_PREFIX}has space`]: "x",
      [`${POE_EXTRA_PREFIX}`]: "x",
    });
    expect(out).not.toHaveProperty("extra_body");
  });

  it("空の独自パラメータは送らない", () => {
    expect(poe({ [`${POE_EXTRA_PREFIX}a`]: "  " })).not.toHaveProperty("extra_body");
  });

  it("型付きの thinking_budget が同名の独自パラメータより優先される", () => {
    const out = poe({
      [`${POE_EXTRA_PREFIX}${POE_THINKING_BUDGET_KEY}`]: "99",
      [POE_THINKING_BUDGET_KEY]: 2048,
    });
    expect((out.extra_body as Record<string, unknown>)[POE_THINKING_BUDGET_KEY]).toBe(
      2048,
    );
  });

  it("reasoning_effort は標準フィールドなのでボディ直下へ置く", () => {
    const out = poe({ [POE_REASONING_EFFORT_KEY]: "high" });
    expect(out[POE_REASONING_EFFORT_KEY]).toBe("high");
    expect(out).not.toHaveProperty("extra_body");
  });

  it("OpenRouter専用の思考指定はPoeへ混ぜない", () => {
    expect(poe({ [REASONING_KEY]: "high" })).not.toHaveProperty("reasoning");
  });
});

describe("parseParamsJson", () => {
  it("壊れたJSONでも例外を投げない", () => {
    for (const bad of ["{", "null", "[]", '"文字列"', "123", "", null, undefined]) {
      expect(parseParamsJson(bad)).toEqual({});
    }
  });

  it("正しいオブジェクトはそのまま返す", () => {
    expect(parseParamsJson('{"temperature":0.7}')).toEqual({ temperature: 0.7 });
  });
});
