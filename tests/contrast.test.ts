import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 文字の読みやすさ（コントラスト比）。
 *
 * 補助的な文字——件数のバッジ、節の見出し、空のときの案内——は
 * neutral-400（ライト）と neutral-600（ダーク）で描いていた。どちらも
 * **2.5:1 前後**で、WCAG が本文に求める 4.5:1 を大きく下回る。薄いのは
 * 意図した控えめさだが、読めないのは控えめとは言わない。
 *
 * 色の値は Tailwind の既定。変えるときはここも一緒に見直す。
 */
const NEUTRAL: Record<string, string> = {
  "300": "#d4d4d4",
  "400": "#a3a3a3",
  "500": "#737373",
  "600": "#525252",
  "700": "#404040",
};
const WHITE = "#ffffff";
/** ダークの地色（app.css の html/body）。 */
const NEUTRAL_950 = "#0a0a0a";

function luminance(hex: string): number {
  const parts = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = parts.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA の本文。 */
const TEXT_MIN = 4.5;
/** WCAG AA の非文字（アイコンや境界）。 */
const UI_MIN = 3;

describe("補助的な文字", () => {
  it("ライトで使う色が本文の基準を満たす", () => {
    expect(contrast(NEUTRAL["500"], WHITE)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it("ダークで使う色が本文の基準を満たす", () => {
    expect(contrast(NEUTRAL["400"], NEUTRAL_950)).toBeGreaterThanOrEqual(
      TEXT_MIN,
    );
  });

  it("以前使っていた色は満たしていなかった", () => {
    // 直したことを、数字で残しておく
    expect(contrast(NEUTRAL["400"], WHITE)).toBeLessThan(TEXT_MIN);
    expect(contrast(NEUTRAL["600"], NEUTRAL_950)).toBeLessThan(TEXT_MIN);
  });
});

describe("hover が無い端末で出す操作の色", () => {
  it("ライトで非文字の基準を満たす", () => {
    expect(contrast(NEUTRAL["500"], WHITE)).toBeGreaterThanOrEqual(UI_MIN);
  });

  it("ダークで非文字の基準を満たす", () => {
    expect(contrast(NEUTRAL["400"], NEUTRAL_950)).toBeGreaterThanOrEqual(
      UI_MIN,
    );
  });

  it("ふだんの薄さは基準を満たさない（だから hover 前提にできない）", () => {
    expect(contrast(NEUTRAL["300"], WHITE)).toBeLessThan(UI_MIN);
    expect(contrast(NEUTRAL["700"], NEUTRAL_950)).toBeLessThan(UI_MIN);
  });
});

/**
 * 意味付きトークン（UI-10）の比。値は app.css から読む——ここに写すと、
 * app.css を変えたときにテストだけ古い値で通り続ける。
 */
function cssTokens(selector: string): Record<string, string> {
  const css = readFileSync("app/app.css", "utf-8");
  // 同じセレクタのブロックはアクセントの分など複数ある。全部を読み、後勝ちで重ねる
  const re = new RegExp(`^${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`, "gm");
  const out: Record<string, string> = {};
  for (const block of css.matchAll(re)) {
    for (const m of block[1].matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  }
  if (!("surface" in out)) throw new Error(`${selector} に --surface が無い`);
  return out;
}

describe("面と文字のトークン", () => {
  const light = cssTokens(":root");
  const dark = cssTokens(":root.dark");

  it("補助の文字（ink-2）は本文の基準を満たす", () => {
    expect(contrast(light["ink-2"], light.surface)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrast(dark["ink-2"], dark.surface)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it("沈んだ面の上でも補助の文字は読める", () => {
    expect(contrast(light["ink-2"], light.sunken)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrast(dark["ink-2"], dark.sunken)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it("薄い印（ink-3）は文字の基準を満たさない——だから読ませる文字には使わない", () => {
    expect(contrast(light["ink-3"], light.surface)).toBeLessThan(TEXT_MIN);
    expect(contrast(dark["ink-3"], dark.surface)).toBeLessThan(TEXT_MIN);
  });
});
