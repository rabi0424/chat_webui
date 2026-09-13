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
  RUNWARE_MODELS,
  buildRunwareModelInfo,
  readRunwareData,
  runwareCreatorOf,
  runwareErrorOf,
  runwareImageTaskBody,
  runwareModelOf,
} = await import("../../app/lib/runware.server");

/** 表の中の、置き場が新しい／古いモデルの識別子。 */
const NEW_GEN = RUNWARE_MODELS.find((m) => !m.providerSettings)!.air;
const OLD_GEN = RUNWARE_MODELS.find((m) => m.providerSettings)!.air;

/**
 * `wide` は受け付けるが `narrow` は受け付けない品質の段。
 *
 * 「段がモデルで違う」ことを使うテストは、この値が無いと**何も検査
 * しないまま通る**（送らない値を送らないことを確かめるだけになる）。
 * 取り出しを1か所にして、使う側で必ず存在を見る。
 */
function extraQualityOf(narrow: string, wide: string): string | undefined {
  const allowed = runwareModelOf(narrow).quality;
  return runwareModelOf(wide).quality.find((q) => !allowed.includes(q));
}

const { readUpstreamJson } = await import("../../app/lib/generation.server");

/** 依頼の組み立ての既定。各テストで要るところだけ上書きする。 */
function task(
  over: Partial<Parameters<typeof runwareImageTaskBody>[0]> = {},
): Record<string, unknown> {
  const body = runwareImageTaskBody({
    model: NEW_GEN,
    prompt: "赤い円",
    referenceImages: [],
    params: {},
    taskUUID: "uuid-1",
    ...over,
  });
  // 依頼は必ず「作業の配列」。1件でも配列で包む
  expect(Array.isArray(body)).toBe(true);
  expect(body).toHaveLength(1);
  return body[0];
}

describe("扱うモデルの表", () => {
  /*
   * 名前を環境変数で受け取らず、表をコードに持つ。モデルごとに
   * 受け付ける設定が違うので、名前だけ外から渡せても足りないため
   * （CLAUDE.md の決まりごとの例外。docs/requirements.md §3.1.2）。
   */
  it("識別子は重複せず、品質の段を必ず持つ", () => {
    expect(RUNWARE_MODELS.length).toBeGreaterThan(0);
    const airs = RUNWARE_MODELS.map((m) => m.air);
    expect(new Set(airs).size).toBe(airs.length);
    for (const m of RUNWARE_MODELS) {
      expect(m.label).toBeTruthy();
      expect(m.quality.length).toBeGreaterThan(0);
      // 「自動」は⚙の側（＝送らない）。選択肢に混ぜると同じ意味の
      // 選び方が2つになる
      expect(m.quality).not.toContain("auto");
      // 置き場の名前は識別子から取るので、取り出せない識別子は表に
      // 置けない（古い置き場のモデルだと入れ子を作れなくなる）
      expect(runwareCreatorOf(m.air)).toBeTruthy();
    }
  });

  it("置き場の違うモデルが両方あり、段の広さも揃っていない", () => {
    /*
     * この2つが同じなら、置き場と段を分ける仕組みそのものを誰も
     * 通らない（＝壊しても気づけない）。表を減らすときはここも見る。
     * 数ではなく**中身**で見る——段の一覧を作り間違えて同じ値が並んだ
     * だけでも数は変わるので、数で見ると違いがあるように見えてしまう。
     */
    expect(RUNWARE_MODELS.some((m) => m.providerSettings)).toBe(true);
    expect(RUNWARE_MODELS.some((m) => !m.providerSettings)).toBe(true);
    expect(extraQualityOf(OLD_GEN, NEW_GEN)).toBeTruthy();
  });

  it("表に無いモデルは、既定で生成できる", () => {
    /*
     * 表から外したモデルが会話に残っていることがある。ここで弾くと、
     * 過去の会話が黙って送信できなくなる。
     */
    const unknown = runwareModelOf("x:y@9");
    expect(unknown.providerSettings).toBe(false);
    expect(unknown.quality.length).toBeGreaterThan(0);
    expect(runwareModelOf(OLD_GEN).providerSettings).toBe(true);
  });
});

describe("一覧の1本", () => {
  it("画像の窓口として載る（入出力とも画像）", () => {
    const info = buildRunwareModelInfo(RUNWARE_MODELS[0]);
    expect(info.id).toBe(`runware:${RUNWARE_MODELS[0].air}`);
    expect(info.name).toBe(RUNWARE_MODELS[0].label);
    expect(info.provider).toBe("runware");
    expect(info.outputModalities).toContain("image");
    expect(info.inputModalities).toContain("image");
    // 上流はコンテキスト長を持たない。推測で埋めず、画面が
    // 「出さない」と判断できる値にする
    expect(info.contextLength).toBe(0);
    expect(info.supportedParameters).toContain("moderation");
  });

  it("品質の段は、モデルごとに画面（⚙）まで持っていく", () => {
    /*
     * 段は世代で違う。クライアントは表を読めないので、ここで載せて
     * おかないと**段の少ないモデルに多いほうを出してしまう**
     * （選べば 400 で1本失う）。
     */
    for (const m of RUNWARE_MODELS) {
      expect(buildRunwareModelInfo(m).runwareQuality).toEqual(m.quality);
    }
  });
});

describe("依頼の組み立て", () => {
  it("会話ではなく、依頼文1本と大きさを送る", () => {
    const t = task({ params: { size: "1536x1024" } });
    expect(t.taskType).toBe("imageInference");
    expect(t.taskUUID).toBe("uuid-1");
    expect(t.model).toBe(NEW_GEN);
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
    const t = task({ params: { moderation: "low", quality: "max" } });
    expect(t.settings).toEqual({ moderation: "low", quality: "max" });
    expect(t.providerSettings).toBeUndefined();
  });

  it("古い世代は、審査と品質を providerSettings.<供給元> へ置く", () => {
    /*
     * ここを取り違えると、**審査の設定が黙って効かない**（上流は知らない
     * 項目を無視する）。絵は出るので画面からは分からない。
     */
    const t = task({
      model: OLD_GEN,
      params: { moderation: "low", quality: "high" },
    });
    expect(t.providerSettings).toEqual({
      [runwareCreatorOf(OLD_GEN)]: { moderation: "low", quality: "high" },
    });
    // settings 側へは残さない（両方へ置くと、片方が知らない項目になる）
    expect(t.settings).toBeUndefined();
  });

  it("背景はどちらの世代でも settings（上流の文書がそう決めている）", () => {
    const t = task({
      model: OLD_GEN,
      params: { background: "opaque", moderation: "low" },
    });
    expect(t.settings).toEqual({ background: "opaque" });
    expect(t.providerSettings).toEqual({
      [runwareCreatorOf(OLD_GEN)]: { moderation: "low" },
    });
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

  it("そのモデルが受け付けない品質の段は送らない", () => {
    /*
     * ⚙は表に沿った選択肢しか出さないが、設定は会話に付いたまま
     * モデルを乗り換えられる。段の少ないモデルへ移ったときに古い値が
     * 残り、そのまま送れば 400 で1本まるごと失う。
     */
    const narrow = runwareModelOf(OLD_GEN).quality;
    const extra = extraQualityOf(OLD_GEN, NEW_GEN);
    // 例が無ければ、以下は「送らない値を送らない」を見るだけになる
    expect(extra).toBeTruthy();
    const t = task({ model: OLD_GEN, params: { moderation: "low", quality: extra } });
    expect(t.providerSettings).toEqual({
      [runwareCreatorOf(OLD_GEN)]: { moderation: "low" },
    });
    // 受け付ける段ならそのまま通る
    expect(
      task({ model: OLD_GEN, params: { quality: narrow[0] } }).providerSettings,
    ).toEqual({ [runwareCreatorOf(OLD_GEN)]: { quality: narrow[0] } });
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

  it("置き場は渡さない（組み立ての側が表を引く）", () => {
    /*
     * 渡す形にすると、引き忘れて既定のまま渡しても型では気づけない
     * （どちらも同じ型なので、審査が黙って効かなくなる）。
     */
    expect(branch).not.toContain("providerSettings");
    expect(branch).toContain("model: modelName");
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
