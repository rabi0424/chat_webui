import { describe, expect, it } from "vitest";
import {
  isShapeChoice,
  orientationLabel,
  parseShape,
  shapeHint,
} from "../app/lib/aspect";

/**
 * 画像の形の読み取り。
 *
 * ここが外すと、UIは**間違った形**を自信たっぷりに描く（縦長の選択肢に
 * 横長の長方形が付く）。「読めない」よりたちが悪いので、向きの判定と
 * 約分を、実際にボットが返す書式で押さえる。
 */
describe("parseShape", () => {
  it("解像度の表記から向きを決める", () => {
    // gpt-image-2 の size がこの3つ。数字の並びだけでは読み取れないもの
    expect(parseShape("1024x1024")?.orientation).toBe("square");
    expect(parseShape("1536x1024")?.orientation).toBe("landscape");
    expect(parseShape("1024x1536")?.orientation).toBe("portrait");
  });

  it("比の表記も同じように読む", () => {
    expect(parseShape("16:9")?.orientation).toBe("landscape");
    expect(parseShape("9:16")?.orientation).toBe("portrait");
    expect(parseShape("1:1")?.orientation).toBe("square");
  });

  it("解像度を約分した比に直す", () => {
    expect(parseShape("1536x1024")?.ratio).toBe("3:2");
    expect(parseShape("1024x1536")?.ratio).toBe("2:3");
    expect(parseShape("1920x1080")?.ratio).toBe("16:9");
    expect(parseShape("1024x1024")?.ratio).toBe("1:1");
  });

  it("比と縦横の値を取り違えない", () => {
    // width/height を入れ替えて持つと、描く長方形が90度回る
    const shape = parseShape("1536x1024");
    expect(shape).toMatchObject({ width: 1536, height: 1024 });
  });

  it("小数の比は約分せずそのまま扱う", () => {
    expect(parseShape("1.91:1")).toMatchObject({
      orientation: "landscape",
      ratio: "1.91:1",
    });
  });

  it("区切りは : x × * と全角混じりの空白を受ける", () => {
    for (const raw of ["16:9", "16x9", "16X9", "16×9", "16*9", " 16 : 9 "]) {
      expect(parseShape(raw)?.ratio, raw).toBe("16:9");
    }
  });

  it("形として読めない値は null", () => {
    for (const raw of [
      "auto",
      "high",
      "",
      "16:",
      ":9",
      "16:9:4",
      "x",
      "-16:9",
      "16:9px",
      "abcx9",
    ]) {
      expect(parseShape(raw), raw).toBeNull();
    }
  });

  it("0 を含む値は形にならない", () => {
    // 0 を通すと線1本の長方形を描き、比としても意味を成さない
    expect(parseShape("0x1024")).toBeNull();
    expect(parseShape("1024x0")).toBeNull();
  });

  it("文字列以外を渡されても落ちない", () => {
    for (const bad of [null, undefined, 16, {}, ["16:9"]]) {
      expect(parseShape(bad)).toBeNull();
    }
  });
});

describe("isShapeChoice", () => {
  it("形の選択肢と分かる並びだけを受ける", () => {
    expect(isShapeChoice(["auto", "1024x1024", "1536x1024", "1024x1536"])).toBe(
      true,
    );
    expect(isShapeChoice(["1:1", "16:9", "9:16"])).toBe(true);
  });

  it("形でない選択肢の並びは巻き込まない", () => {
    // quality や reasoning_effort に長方形が付くと、意味の無い図になる
    expect(isShapeChoice(["low", "medium", "high"])).toBe(false);
    expect(isShapeChoice(["true", "false"])).toBe(false);
    expect(isShapeChoice([])).toBe(false);
  });

  it("たまたま形に見える値が1つだけなら形の選択肢とみなさない", () => {
    expect(isShapeChoice(["auto", "16:9"])).toBe(false);
  });
});

describe("shapeHint", () => {
  it("解像度には比と向きの両方を添える", () => {
    expect(shapeHint("1536x1024", parseShape("1536x1024")!)).toBe("3:2 横長");
  });

  it("値がすでに比なら向きだけを添える", () => {
    // "16:9" の隣に "16:9 横長" と出すと、同じ表記が2度並ぶ
    expect(shapeHint("16:9", parseShape("16:9")!)).toBe("横長");
    expect(shapeHint(" 9:16 ", parseShape("9:16")!)).toBe("縦長");
  });

  it("比の表記は約分し直さない", () => {
    // "21:9" の隣に "7:3" と出ると、別の値を指しているように見える
    expect(shapeHint("21:9", parseShape("21:9")!)).toBe("横長");
    expect(shapeHint("1.91:1", parseShape("1.91:1")!)).toBe("横長");
  });
});

describe("orientationLabel", () => {
  it("向きごとに違う言葉になる", () => {
    const labels = (["square", "landscape", "portrait"] as const).map(
      orientationLabel,
    );
    expect(new Set(labels).size).toBe(3);
    expect(labels).toEqual(["正方形", "横長", "縦長"]);
  });
});
