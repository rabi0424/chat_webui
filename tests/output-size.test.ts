import { describe, expect, it } from "vitest";
import {
  adjustmentText,
  fitRunwareSize,
  megapixelLabel,
  megapixelText,
  nearestAllowedSize,
  parseSizeValue,
  RUNWARE_LIMITS,
  scaledOutputSize,
  sizeText,
  sizeValue,
  type ImageSize,
} from "../app/lib/output-size";

/**
 * 入力画像を倍した大きさの決め方。
 *
 * ここが外れる壊れ方は2通りある。**枠から1段はみ出す**と上流が 400 を
 * 返し、その1本をまるごと失う（課金だけ済んでいることもある）。**枠に
 * 収まってしまう**と、頼んだ覚えのない大きさで絵が出る——エラーは出ず、
 * 額と待ち時間だけが増える。どちらも画面には出ないので、ここで押さえる。
 */

const { step, minPixels, maxPixels, maxRatio } = RUNWARE_LIMITS;

/** 上流の決まりを、そのまま検査にする。 */
function satisfiesRunware(size: ImageSize): string[] {
  const broken: string[] = [];
  if (size.width % step !== 0 || size.height % step !== 0) {
    broken.push(`16の倍数でない: ${sizeValue(size)}`);
  }
  const pixels = size.width * size.height;
  if (pixels > maxPixels) broken.push(`画素数が上限超え: ${pixels}`);
  if (pixels < minPixels) broken.push(`画素数が下限未満: ${pixels}`);
  const ratio = Math.max(size.width / size.height, size.height / size.width);
  if (ratio > maxRatio) broken.push(`縦横比が 3:1 超え: ${ratio}`);
  return broken;
}

describe("fitRunwareSize（上流の決まりに収める）", () => {
  it("枠の中の大きさは、16の倍数へ寄せるだけ", () => {
    const { size, adjustment } = fitRunwareSize({ width: 2000, height: 1500 });
    expect(size).toEqual({ width: 2000, height: 1504 });
    expect(adjustment).toBeNull();
  });

  /*
   * 4K の写真を2倍すると 33MP。上流の上限は 8.3MP なので、そのまま
   * 送れば 400 で1本失う。縮めた上で、**縮めたことを画面に言える**ように
   * 理由を返す（黙って小さく作られるのがいちばん分かりにくい）。
   */
  it("上限を超える倍率は、比を保って上限まで縮める", () => {
    const { size, adjustment } = fitRunwareSize({ width: 7680, height: 4320 });
    expect(adjustment).toBe("max");
    expect(satisfiesRunware(size)).toEqual([]);
    // 16:9 のまま（±1段まで）
    expect(size.width / size.height).toBeCloseTo(16 / 9, 1);
  });

  it("小さすぎる入力は、下限まで広げる", () => {
    const { size, adjustment } = fitRunwareSize({ width: 320, height: 240 });
    expect(adjustment).toBe("min");
    expect(satisfiesRunware(size)).toEqual([]);
    expect(size.width / size.height).toBeCloseTo(4 / 3, 1);
  });

  it("細長すぎる入力は、3:1 まで詰める", () => {
    const { size, adjustment } = fitRunwareSize({ width: 4000, height: 500 });
    expect(adjustment).toBe("ratio");
    expect(satisfiesRunware(size)).toEqual([]);
  });

  /**
   * 上限ちょうどに当たるときの丸め。
   *
   * 先に16の倍数へ四捨五入してから上限に当てると、**切り上げた1段ぶんだけ
   * 枠を超えた**値が残る。それが 400 になる（画素数の上限は等号を含まない
   * のではなく、超えた時点で弾かれる）。
   */
  it("丸めで枠を1段もはみ出さない", () => {
    for (const target of [
      { width: 3840, height: 2160 }, // 8.3MP ちょうど
      { width: 3841, height: 2161 },
      { width: 2879, height: 2879 },
      { width: 4988, height: 1663 }, // 上限かつ 3:1 すれすれ
    ]) {
      expect(satisfiesRunware(fitRunwareSize(target).size)).toEqual([]);
    }
  });

  /**
   * 入口は⚙の倍率なので、値は何でも来る。**どんな入力からも、上流の
   * 決まりを満たす大きさしか出てこない**ことを、広く試して押さえる。
   */
  it("どんな入力でも、3つの決まりを同時に満たす", () => {
    const broken: string[] = [];
    // 乱数ではなく決め打ちの並びにする（落ちたときに同じ値で再現できる）
    for (let w = 1; w <= 12000; w = Math.ceil(w * 1.37)) {
      for (let h = 1; h <= 12000; h = Math.ceil(h * 1.53)) {
        const { size } = fitRunwareSize({ width: w, height: h });
        const bad = satisfiesRunware(size);
        if (bad.length > 0) broken.push(`${w}x${h} → ${bad.join(" / ")}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("nearestAllowedSize（API易の選択肢へ寄せる）", () => {
  const ALLOWED = [
    "1024x1024",
    "1536x1024",
    "1024x1536",
    "2048x2048",
    "2048x1152",
    "3840x2160",
    "2160x3840",
  ];

  /*
   * 向きを最優先にするのは、縦長の写真を倍したのに横長の枠で作られると
   * 「拡大」ではなく「作り直し」になるため。画素数だけで選ぶと、
   * 2160x3840 より近い横長が混ざったときに向きが裏返る。
   */
  it("縦長の入力には縦長の選択肢を選ぶ", () => {
    const got = nearestAllowedSize({ width: 2048, height: 3600 }, ALLOWED);
    expect(got?.value).toBe("2160x3840");
  });

  it("横長の入力には横長の選択肢を選ぶ", () => {
    const got = nearestAllowedSize({ width: 3600, height: 2048 }, ALLOWED);
    expect(got?.value).toBe("3840x2160");
  });

  it("正方形が無ければ、向きが違っても画素数の近いものを選ぶ", () => {
    const got = nearestAllowedSize({ width: 1000, height: 1000 }, [
      "1536x1024",
      "3840x2160",
    ]);
    expect(got?.value).toBe("1536x1024");
  });

  it("画素数は比で近さを測る（差で測ると遠いほうを選ぶ）", () => {
    /*
     * 的は 2.0MP。差で測ると 1.0MP（-1.0MP）のほうが 3.0MP（+1.0MP）より
     * わずかに近く見えるが、**倍率で見れば半分より1.5倍のほうが近い**。
     * 拡大を頼んでいるのに縮むほうを選ぶのは、頼んだことと逆になる。
     */
    const got = nearestAllowedSize({ width: 1414, height: 1414 }, [
      "1000x1000",
      "1732x1732",
    ]);
    expect(got?.value).toBe("1732x1732");
  });

  it("的に近い選択肢を選ぶ", () => {
    expect(
      nearestAllowedSize({ width: 1000, height: 1000 }, ALLOWED)?.value,
    ).toBe("1024x1024");
  });

  it("同じ近さなら小さいほうを選ぶ（頼んでいない額をかけない）", () => {
    // 2.0MP の的に対し、1.0MP と 4.0MP は比では同じ近さ
    const got = nearestAllowedSize({ width: 1414, height: 1414 }, [
      "1000x1000",
      "2000x2000",
    ]);
    expect(got?.value).toBe("1000x1000");
  });

  it("読めない選択肢しか無ければ、諦めて null", () => {
    expect(nearestAllowedSize({ width: 100, height: 100 }, ["auto"])).toBeNull();
  });
});

describe("scaledOutputSize（窓口ごとの入口）", () => {
  it("倍率を掛けてから窓口の決まりに当てる", () => {
    const got = scaledOutputSize({ width: 1024, height: 768 }, 2, {
      provider: "runware",
    });
    expect(got?.size).toEqual({ width: 2048, height: 1536 });
  });

  it("倍率は範囲へ丸める（保存済みの極端な値で巨大画像を作らせない）", () => {
    const huge = scaledOutputSize({ width: 1024, height: 1024 }, 999, {
      provider: "runware",
    });
    expect(satisfiesRunware(huge!.size)).toEqual([]);
    // 4倍を超えては掛からない
    expect(huge!.size.width).toBeLessThanOrEqual(1024 * 4);
  });

  it("API易 では選択肢の値そのものを返す", () => {
    const got = scaledOutputSize({ width: 1024, height: 1024 }, 2, {
      provider: "apiyi",
      allowed: ["1024x1024", "2048x2048"],
    });
    expect(got?.value).toBe("2048x2048");
  });

  it("大きさとして読めない入力は諦める", () => {
    expect(
      scaledOutputSize({ width: 0, height: 100 }, 2, { provider: "runware" }),
    ).toBeNull();
  });
});

describe("表示の書式", () => {
  it("MP は小数第1位まで", () => {
    expect(megapixelText({ width: 3840, height: 2160 })).toBe("8.3MP");
    expect(megapixelLabel(1_000_000)).toBe("1.0MP");
  });

  /** 0.0MP は「大きさが無い」と区別が付かない。 */
  it("小さすぎる絵は 0.0MP と書かない", () => {
    expect(megapixelText({ width: 40, height: 24 })).toBe("0.1MP未満");
  });

  it("画面用は ×、送信用は x", () => {
    expect(sizeText({ width: 1536, height: 1024 })).toBe("1536×1024");
    expect(sizeValue({ width: 1536, height: 1024 })).toBe("1536x1024");
  });

  it("送信用の書式は、読み直して同じ大きさになる", () => {
    const size = { width: 3072, height: 2048 };
    expect(parseSizeValue(sizeValue(size))).toEqual(size);
  });

  it("動かした理由には、その場で読める言葉を出す", () => {
    expect(adjustmentText("max")).toContain("8.3MP");
    expect(adjustmentText("ratio")).toContain("3:1");
    expect(adjustmentText(null)).toBeNull();
  });
});
