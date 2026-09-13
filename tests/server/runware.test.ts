import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Runware（4つ目の窓口）の組み立てと読み取り。
 *
 * この窓口は OpenAI 互換ではない。依頼は**作業（task）の配列**で、
 * 審査・品質の置き場はモデルの世代で変わる。入れ子を1つ間違えたときに
 * 返ってくるのは 400 か、**何事も無く効かない設定**で、画面からは
 * 見分けが付かない（絵は出るのに、緩めたはずの判定がかかったまま）。
 * 組み立てと読み取りをここで直に見る。
 */
const {
  buildRunwareModelInfo,
  findRunwareSpec,
  parseRunwareModelSpecs,
  readRunwareData,
  runwareCreatorOf,
  runwareErrorOf,
  runwareImageTaskBody,
} = await import("../../app/lib/runware.server");

const { readUpstreamJson } = await import("../../app/lib/generation.server");

/** 依頼の組み立ての既定。各テストで要るところだけ上書きする。 */
function task(
  over: Partial<Parameters<typeof runwareImageTaskBody>[0]> = {},
): Record<string, unknown> {
  const body = runwareImageTaskBody({
    model: "vendor:family@1",
    prompt: "赤い円",
    referenceImages: [],
    params: {},
    providerSettings: false,
    taskUUID: "uuid-1",
    ...over,
  });
  // 依頼は必ず「作業の配列」。1件でも配列で包む
  expect(Array.isArray(body)).toBe(true);
  expect(body).toHaveLength(1);
  return body[0];
}

describe("一覧に載せるモデルの指定", () => {
  it("カンマ・空白・改行のどれで区切ってもよく、重複は1本にする", () => {
    expect(parseRunwareModelSpecs("a:b@1, c:d@2\ne:f@3").map((s) => s.air)).toEqual(
      ["a:b@1", "c:d@2", "e:f@3"],
    );
    expect(parseRunwareModelSpecs(" a:b@1 , a:b@1 ")).toHaveLength(1);
    expect(parseRunwareModelSpecs("")).toEqual([]);
    expect(parseRunwareModelSpecs(undefined)).toEqual([]);
  });

  it("`|providerSettings` を添えたものだけ古い置き場になる", () => {
    const specs = parseRunwareModelSpecs("a:b@1|providerSettings, c:d@2");
    expect(specs[0]).toMatchObject({ air: "a:b@1", providerSettings: true });
    expect(specs[1]).toMatchObject({ air: "c:d@2", providerSettings: false });
    // 大文字小文字は問わない（環境変数へ手で書く値なので）
    expect(parseRunwareModelSpecs("a:b@1|ProviderSettings")[0].providerSettings)
      .toBe(true);
  });

  it("解釈できない指定は、そうと分かる形で残す", () => {
    /*
     * 黙って既定（新しい置き場）へ倒すと、**審査の設定が効かないまま
     * 絵だけが出る**。書き間違いに気づく手立てが要る。
     */
    const spec = parseRunwareModelSpecs("a:b@1|provider-settings")[0];
    expect(spec.providerSettings).toBe(false);
    expect(spec.unknownOption).toBe("provider-settings");
    expect(buildRunwareModelInfo(spec).description).toContain("provider-settings");
    // 正しく書けているモデルの説明に、余計な注記は出さない
    expect(
      buildRunwareModelInfo(parseRunwareModelSpecs("a:b@1|providerSettings")[0])
        .description,
    ).not.toContain("解釈できません");
  });

  it("一覧から外れたモデルが会話に残っていても、既定で生成できる", () => {
    const specs = parseRunwareModelSpecs("a:b@1|providerSettings");
    expect(findRunwareSpec(specs, "a:b@1").providerSettings).toBe(true);
    expect(findRunwareSpec(specs, "x:y@9")).toEqual({
      air: "x:y@9",
      providerSettings: false,
    });
  });
});

describe("一覧の1本", () => {
  it("画像の窓口として載る（入出力とも画像）", () => {
    const info = buildRunwareModelInfo({ air: "a:b@1", providerSettings: false });
    expect(info.id).toBe("runware:a:b@1");
    expect(info.provider).toBe("runware");
    expect(info.outputModalities).toContain("image");
    expect(info.inputModalities).toContain("image");
    // 上流はコンテキスト長を持たない。推測で埋めず、画面が
    // 「出さない」と判断できる値にする
    expect(info.contextLength).toBe(0);
    expect(info.supportedParameters).toContain("moderation");
  });

  it("置き場の指定は、画面（⚙）まで持っていく", () => {
    /*
     * 品質の段は世代で違う。クライアントは環境変数を読めないので、
     * ここで載せておかないと**古いモデルに新しい段を出してしまう**
     * （選べば 400 で1本失う）。
     */
    expect(
      buildRunwareModelInfo({ air: "a:b@1", providerSettings: true })
        .runwareProviderSettings,
    ).toBe(true);
    expect(
      buildRunwareModelInfo({ air: "a:b@1", providerSettings: false })
        .runwareProviderSettings,
    ).toBe(false);
  });
});

describe("依頼の組み立て", () => {
  it("会話ではなく、依頼文1本と大きさを送る", () => {
    const t = task({ params: { size: "1536x1024" } });
    expect(t.taskType).toBe("imageInference");
    expect(t.taskUUID).toBe("uuid-1");
    expect(t.model).toBe("vendor:family@1");
    expect(t.positivePrompt).toBe("赤い円");
    expect(t.width).toBe(1536);
    expect(t.height).toBe(1024);
    // 額が載らないと台帳から丸ごと落ちる
    expect(t.includeCost).toBe(true);
  });

  it("大きさを選んでいなくても送る（上流が必須にしている）", () => {
    /*
     * 他の項目と違い「送らない＝上流の既定」にできない。読めない値が
     * 残っていても、依頼そのものは通す。
     */
    expect(task()).toMatchObject({ width: 1024, height: 1024 });
    expect(task({ params: { size: "とても大きく" } })).toMatchObject({
      width: 1024,
      height: 1024,
    });
  });

  it("新しい世代は、審査と品質を settings へ置く", () => {
    const t = task({
      params: { moderation: "low", quality: "max" },
      providerSettings: false,
    });
    expect(t.settings).toEqual({ moderation: "low", quality: "max" });
    expect(t.providerSettings).toBeUndefined();
  });

  it("古い世代は、審査と品質を providerSettings.<供給元> へ置く", () => {
    /*
     * ここを取り違えると、**審査の設定が黙って効かない**（上流は知らない
     * 項目を無視する）。絵は出るので画面からは分からない。
     */
    const t = task({
      params: { moderation: "low", quality: "high" },
      providerSettings: true,
    });
    expect(t.providerSettings).toEqual({
      vendor: { moderation: "low", quality: "high" },
    });
    // settings 側へは残さない（両方へ置くと、片方が知らない項目になる）
    expect(t.settings).toBeUndefined();
  });

  it("背景はどちらの世代でも settings（上流の文書がそう決めている）", () => {
    const t = task({
      params: { background: "opaque", moderation: "low" },
      providerSettings: true,
    });
    expect(t.settings).toEqual({ background: "opaque" });
    expect(t.providerSettings).toEqual({ vendor: { moderation: "low" } });
  });

  it("背景を指定したら形式も送る。透過なら JPG に落とさない", () => {
    /*
     * 上流は「背景を指定するなら形式も必須」「透過は PNG か WEBP のみ」
     * と決めている。どちらも守らないと 400 で1本まるごと失う。
     */
    expect(task({ params: { background: "opaque" } }).outputFormat).toBe("PNG");
    expect(
      task({ params: { background: "transparent", output_format: "JPG" } })
        .outputFormat,
    ).toBe("PNG");
    // 透過を扱える形式を選んでいれば、そのまま
    expect(
      task({ params: { background: "transparent", output_format: "WEBP" } })
        .outputFormat,
    ).toBe("WEBP");
    // 背景を触っていないなら、形式は⚙の指定どおり（自動なら送らない）
    expect(task({ params: { output_format: "JPG" } }).outputFormat).toBe("JPG");
    expect(task().outputFormat).toBeUndefined();
  });

  it("参照画像は data: URL のまま渡し、上流の上限（16枚）で切る", () => {
    const url = "data:image/png;base64,AAA";
    const t = task({ referenceImages: Array.from({ length: 20 }, () => url) });
    expect((t.inputs as { referenceImages: string[] }).referenceImages).toHaveLength(
      16,
    );
    // 添付が無ければ inputs ごと送らない（空配列は上流が弾く）
    expect(task().inputs).toBeUndefined();
  });

  it("⚙が自動のままなら、入れ子そのものを送らない", () => {
    const t = task();
    expect(t.settings).toBeUndefined();
    expect(t.providerSettings).toBeUndefined();
    expect(t.outputQuality).toBeUndefined();
  });

  it("供給元を取り出せないモデル識別子では、古い置き場を作らない", () => {
    // 置き場の名前は識別子から取る。取れないまま空の名前で包むと、
    // 上流には「知らない入れ子」として届く
    expect(runwareCreatorOf("vendor:family@1")).toBe("vendor");
    expect(runwareCreatorOf("名前のない識別子")).toBe("");
    const t = task({
      model: "名前のない識別子",
      params: { moderation: "low" },
      providerSettings: true,
    });
    expect(t.providerSettings).toBeUndefined();
  });
});

describe("応答の読み取り", () => {
  it("画像と実費を取り出す（額は作業ごとに足す）", () => {
    const out = readRunwareData([
      { imageURL: "https://im.example/1.jpg", cost: 0.02 },
      { imageURL: "https://im.example/2.jpg", cost: 0.03 },
    ]);
    expect(out.imageUrls).toEqual([
      "https://im.example/1.jpg",
      "https://im.example/2.jpg",
    ]);
    expect(out.costUsd).toBeCloseTo(0.05, 12);
  });

  it("base64 で返ってきても data: URL の形に揃える", () => {
    expect(readRunwareData([{ imageBase64Data: "AAAA" }]).imageUrls).toEqual([
      "data:image/png;base64,AAAA",
    ]);
    expect(
      readRunwareData([{ imageDataURI: "data:image/webp;base64,BBBB" }]).imageUrls,
    ).toEqual(["data:image/webp;base64,BBBB"]);
  });

  it("画像も額も無い応答で、作り話をしない", () => {
    expect(readRunwareData(undefined)).toEqual({ imageUrls: [], costUsd: null });
    expect(readRunwareData([{}])).toEqual({ imageUrls: [], costUsd: null });
  });

  it("エラーは配列で届く（`error` ではない）", () => {
    /*
     * 他の窓口と同じ読み方をすると、**理由がどこにも出ないまま**
     * 「本文のない応答」になる。code も数値ではなく文字列。
     */
    const err = runwareErrorOf({
      errors: [
        { code: "invalidParameter", message: "だめでした", parameter: "width" },
      ],
    });
    expect(err?.detail).toContain("だめでした");
    expect(err?.detail).toContain("width");
    expect(err?.type).toBe("invalidParameter");
    // 数値の状態コードではないので、そちらへは入れない
    expect(err?.code).toBeNull();
    expect(runwareErrorOf({ errors: [] })).toBeUndefined();
    expect(runwareErrorOf({ error: { message: "別の窓口" } })).toBeUndefined();
  });
});

/**
 * 応答の読み手（generation.server）との結び付き。
 *
 * `data` という名前は API易 の Images API と同じだが、**中の項目名が
 * 違う**（`imageURL`・`cost`）。読み手が片方しか見ていないと、画像も額も
 * 丸ごと落ちて「本文のない応答」になる——上流では生成が終わって
 * 課金されている。
 */
describe("readUpstreamJson が Runware の応答を落とさない", () => {
  const bodyOf = (v: unknown): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(v)));
        c.close();
      },
    });

  it("画像を拾い、額を usage に載せる", async () => {
    const result = await readUpstreamJson(
      bodyOf({
        data: [
          {
            taskType: "imageInference",
            imageURL: "https://im.example/a.jpg",
            cost: 0.0324,
          },
        ],
      }),
    );
    expect(result.imageUrls).toEqual(["https://im.example/a.jpg"]);
    // 額が無い記録は台帳から丸ごと捨てられる
    expect(JSON.parse(result.usageJson ?? "{}")).toEqual({ cost: 0.0324 });
  });

  it("エラーだけの応答は、理由を持ち帰る", async () => {
    const result = await readUpstreamJson(
      bodyOf({ errors: [{ code: "invalidModel", message: "そんなモデルは無い" }] }),
    );
    expect(result.error?.detail).toContain("そんなモデルは無い");
    expect(result.imageUrls).toEqual([]);
  });

  it("他の窓口の応答は、今までどおり読める", async () => {
    /*
     * 同じ `data` を両方の読み方で通すので、片方を足したせいで
     * もう片方が壊れていないことも見る。
     */
    const result = await readUpstreamJson(
      bodyOf({
        data: [{ b64_json: "AAAA" }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    );
    expect(result.imageUrls).toEqual(["data:image/png;base64,AAAA"]);
    expect(JSON.parse(result.usageJson ?? "{}")).toMatchObject({
      promptTokens: 10,
      completionTokens: 20,
    });
  });
});

/**
 * 生成の配線。
 *
 * 実行体そのものを回すには上流・D1・R2・DO を全部差し替える必要がある
 * ので、ここでは配線だけを見る（retry-stop-wiring.test.ts と同じ形）。
 * ここが外れたときの壊れ方は**画面に出ない**——絵は出るのに、⚙で
 * 選んだ審査の強さだけが効かない。
 */
describe("requestUpstream の Runware 分岐", () => {
  const gen = readFileSync("app/lib/generation.server.ts", "utf8");
  const branch = gen.match(/if \(provider === "runware"\)[\s\S]*?\n {2}}\n/)?.[0];

  it("置き場は環境変数から引き直す（決め打ちにしない）", () => {
    expect(branch).toContain("runwareSpecOf(modelName).providerSettings");
  });

  it("参照画像は data: URL のまま渡す（復号して詰め直さない）", () => {
    expect(branch).toContain("referenceImages: dataUrls");
  });

  it("⚙の値は、この窓口の許可リストを通してから渡す", () => {
    expect(branch).toContain(
      'buildGenerationPayload(job.paramsState, "runware")',
    );
  });
});
