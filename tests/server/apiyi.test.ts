import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * API易（中継）の素性の読み取り。
 *
 * この窓口は、こちらが必要とするものをまとめては返さない:
 *   - モデル一覧（/v1/models）はモデル名しか返さない
 *   - 応答に額が載らない（OpenRouter の usage.cost に当たるものが無い）
 * そこで、認証の要らない価格表から素性と単価を読み、額は自分で出す。
 * ここを取り違えると**台帳に何も載らない**（cost も points も無い記録は
 * 丸ごと捨てられる）ので、変換の式を実際の行で見る。
 */
const {
  applyApiyiCost,
  buildApiyiModelInfo,
  estimateApiyiCost,
  parseApiyiModelNames,
  parseApiyiPricingRow,
  resetApiyiPricingCache,
} = await import("../../app/lib/apiyi.server");

afterEach(() => {
  resetApiyiPricingCache();
  vi.unstubAllGlobals();
});

/** 上流の価格表の実物（トークン従量・画像を出すモデル）。 */
const perTokenRow = {
  model_name: "some-image-model",
  vendor_name: "SomeVendor",
  quota_type: 0,
  model_ratio: 2.5,
  model_price: 0,
  completion_ratio: 6,
  supported_endpoint_types: ["image-generation", "openai"],
};

/** 1回いくらのモデル。 */
const perCallRow = {
  model_name: "some-flat-model",
  vendor_name: "SomeVendor",
  quota_type: 1,
  model_ratio: 1,
  model_price: 0.06,
  completion_ratio: 1,
  supported_endpoint_types: ["image-generation", "openai"],
};

describe("価格表の読み取り", () => {
  it("倍率をトークン単価へ直す（倍率1 = $0.002/1K）", () => {
    const spec = parseApiyiPricingRow(perTokenRow);
    // 倍率2.5 → 入力 $5/M、完了倍率6 → 出力 $30/M。
    // 上流が別に公開している実額と一致する
    expect(spec?.inputUsdPerToken).toBeCloseTo(5 / 1_000_000, 12);
    expect(spec?.outputUsdPerToken).toBeCloseTo(30 / 1_000_000, 12);
    expect(spec?.perCallUsd).toBeUndefined();
  });

  it("1回いくらのモデルは、その額を持つ", () => {
    expect(parseApiyiPricingRow(perCallRow)?.perCallUsd).toBe(0.06);
  });

  it("従量の行に載っている model_price を1回ぶんとして読まない", () => {
    /*
     * 実物の価格表には、quota_type が 0（従量）なのに model_price が
     * 0 以外の行がある。quota_type を見ずに model_price だけで判定
     * すると、トークン課金のモデルに1回ぶんの額が上乗せされる——
     * 台帳の数字だけが黙って増え、画面では気づけない。
     */
    const spec = parseApiyiPricingRow({ ...perTokenRow, model_price: 0.2 });
    expect(spec?.perCallUsd).toBeUndefined();
    expect(spec?.inputUsdPerToken).toBeCloseTo(5 / 1_000_000, 12);
  });

  it("画像を出すかはエンドポイントの種別で決まる", () => {
    expect(parseApiyiPricingRow(perTokenRow)?.imageOutput).toBe(true);
    expect(
      parseApiyiPricingRow({
        ...perTokenRow,
        supported_endpoint_types: ["openai"],
      })?.imageOutput,
    ).toBe(false);
  });

  it("名前の無い行は読まない", () => {
    expect(parseApiyiPricingRow({ ...perTokenRow, model_name: "" })).toBeUndefined();
    expect(parseApiyiPricingRow({ ...perTokenRow, model_name: 42 })).toBeUndefined();
  });
});

describe("一覧に載せるモデルの指定", () => {
  it("カンマ・空白・改行のどれで区切ってもよく、重複は1本にする", () => {
    expect(parseApiyiModelNames("a, b\nc  d")).toEqual(["a", "b", "c", "d"]);
    expect(parseApiyiModelNames(" a , a ")).toEqual(["a"]);
    expect(parseApiyiModelNames("")).toEqual([]);
    expect(parseApiyiModelNames(undefined)).toEqual([]);
  });
});

describe("一覧の1本", () => {
  it("画像を出すモデルは、入出力とも画像として載る", () => {
    const info = buildApiyiModelInfo("some-image-model", parseApiyiPricingRow(perTokenRow));
    expect(info.id).toBe("apiyi:some-image-model");
    expect(info.provider).toBe("apiyi");
    expect(info.outputModalities).toContain("image");
    expect(info.inputModalities).toContain("image");
    // 中継はコンテキスト長も対応パラメータも申告しない。推測で
    // 埋めず、画面が「出さない」と判断できる値にする
    expect(info.contextLength).toBe(0);
    expect(info.supportedParameters).toEqual([]);
  });

  it("価格表に無い名前も一覧には出す（設定が効いていないのと区別するため）", () => {
    const info = buildApiyiModelInfo("unknown-model", undefined);
    expect(info.id).toBe("apiyi:unknown-model");
    expect(info.description).toContain("価格");
    expect(info.outputModalities).not.toContain("image");
  });
});

describe("額の見積もり", () => {
  it("トークン数 × 単価", () => {
    const spec = parseApiyiPricingRow(perTokenRow);
    expect(
      estimateApiyiCost(spec, { promptTokens: 1_000_000, completionTokens: 0 }),
    ).toBeCloseTo(5, 9);
    expect(
      estimateApiyiCost(spec, { promptTokens: 0, completionTokens: 1_000_000 }),
    ).toBeCloseTo(30, 9);
  });

  it("1回いくらのモデルは、トークン数を見ない", () => {
    const spec = parseApiyiPricingRow(perCallRow);
    expect(estimateApiyiCost(spec, { promptTokens: 0, completionTokens: 0 })).toBe(0.06);
    expect(
      estimateApiyiCost(spec, { promptTokens: 999, completionTokens: 999 }),
    ).toBe(0.06);
  });

  it("単価が分からなければ額を作らない", () => {
    expect(estimateApiyiCost(undefined, { promptTokens: 10, completionTokens: 10 })).toBeNull();
    expect(
      estimateApiyiCost(
        { inputUsdPerToken: 0, outputUsdPerToken: 0 },
        { promptTokens: 10, completionTokens: 10 },
      ),
    ).toBeNull();
  });
});

/** 価格表を1回だけ返す fetch。呼ばれた回数も数える。 */
function stubPricing(rows: unknown[]): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ success: true, data: rows }), {
      headers: { "content-type": "application/json" },
    });
  });
  return { calls: () => calls };
}

describe("applyApiyiCost", () => {
  it("応答のトークン数から額を足す", async () => {
    stubPricing([perTokenRow]);
    const out = await applyApiyiCost(
      "apiyi:some-image-model",
      JSON.stringify({ promptTokens: 1_000, completionTokens: 2_000 }),
    );
    const usage = JSON.parse(out ?? "{}") as Record<string, number>;
    expect(usage.cost).toBeCloseTo(1_000 * 5e-6 + 2_000 * 30e-6, 12);
    // 元の項目は残す（応答詳細のトークン表示が消えないこと）
    expect(usage.promptTokens).toBe(1_000);
    expect(usage.completionTokens).toBe(2_000);
  });

  it("他の窓口のモデルには触らない（価格表も取りに行かない）", async () => {
    const pricing = stubPricing([perTokenRow]);
    const before = JSON.stringify({ promptTokens: 1, completionTokens: 1 });
    expect(await applyApiyiCost("openai/gpt-4o-mini", before)).toBe(before);
    expect(await applyApiyiCost("poe:GPT-Image-2", before)).toBe(before);
    expect(pricing.calls()).toBe(0);
  });

  it("上流が額を載せてきたら、そちらを残す", async () => {
    stubPricing([perTokenRow]);
    const before = JSON.stringify({
      promptTokens: 1_000,
      completionTokens: 1_000,
      cost: 0.5,
    });
    expect(await applyApiyiCost("apiyi:some-image-model", before)).toBe(before);
  });

  it("1回いくらのモデルは、使用量が返らなくても額を載せる", async () => {
    /*
     * 額が出ないと、その記録は「cost も points も無い」として台帳から
     * 丸ごと落ちる。1回ぶん課金されているのに使用量の画面にも月間上限
     * にも出てこない、という形で消える。
     */
    stubPricing([perCallRow]);
    const out = await applyApiyiCost("apiyi:some-flat-model", null);
    expect(JSON.parse(out ?? "{}")).toMatchObject({ cost: 0.06 });
  });

  it("価格表は実行体の中で使い回す（生成のたびに取りに行かない）", async () => {
    const pricing = stubPricing([perTokenRow]);
    const usage = JSON.stringify({ promptTokens: 10, completionTokens: 10 });
    await applyApiyiCost("apiyi:some-image-model", usage);
    await applyApiyiCost("apiyi:some-image-model", usage);
    expect(pricing.calls()).toBe(1);
  });

  it("価格表が取れなければ、使用量をそのまま返す（生成は止めない）", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("圏外");
    });
    const before = JSON.stringify({ promptTokens: 10, completionTokens: 10 });
    expect(await applyApiyiCost("apiyi:some-image-model", before)).toBe(before);
  });
});
