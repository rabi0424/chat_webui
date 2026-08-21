import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 指で使う端末向けの見た目が、本当にその端末でだけ効くか。
 *
 * hover でだけ濃くする作りは、hover の無い端末では淡いままになる
 * （iPhone では白地に neutral-300 ＝ 約1.5:1 で、事実上見えなかった）。
 * touch: 変種でそこを補っているが、**当たっているかは CSS を見ないと
 * 分からない**——クラス名を間違えても、Tailwind は何も言わずに
 * その規則を出さないだけなので、型チェックもテストも通ってしまう。
 *
 * 実際、素の [@media(hover:none)]: を dark: と重ねたときは、
 * メディアクエリの外れた規則が出ていて、デスクトップのダークにも
 * 当たっていた。ここはビルド結果を直接見る。
 */
const CSS_DIR = "build/client/assets";

function builtCss(): string | null {
  let files: string[];
  try {
    files = readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  return files.map((f) => readFileSync(`${CSS_DIR}/${f}`, "utf-8")).join("\n");
}

/** hover の無い端末向けのブロックだけを取り出す。 */
function touchBlock(css: string): string {
  const i = css.search(/@media\s*\(hover:\s*none\)/);
  if (i < 0) return "";
  // 最小化されているので、次の @media までを見る
  const rest = css.slice(i + 10);
  const j = rest.search(/@media/);
  return j < 0 ? rest : rest.slice(0, j);
}

const css = builtCss();

// ビルドしていない環境（テストだけ流す場合）では飛ばす
describe.skipIf(css == null)("touch 変種", () => {
  const block = touchBlock(css ?? "");

  it("hover の無い端末向けのブロックが出ている", () => {
    expect(block).not.toBe("");
  });

  it("薄すぎて見えなかった操作に、読める色が当たる", () => {
    expect(block).toContain("touch\\:text-neutral-500");
    expect(block).toContain("touch\\:dark\\:text-neutral-400");
  });

  it("押せる大きさを広げる指定が当たる", () => {
    expect(block).toContain("touch\\:p-2");
    expect(block).toContain("touch\\:px-2");
  });

  it("hover で出していたものが、最初から出る", () => {
    expect(block).toContain("touch\\:block");
    expect(block).toContain("touch\\:opacity-100");
  });

  /**
   * これが本題。dark: と重ねた規則がメディアクエリの外に出ると、
   * デスクトップのダークにも当たってしまう。
   */
  it("touch の規則がメディアクエリの外へ漏れていない", () => {
    const outside = (css ?? "").replace(block, "");
    const leaked = outside.match(/\.touch\\:[^{]*\{/g) ?? [];
    expect(leaked).toEqual([]);
  });
});

/**
 * 動きを控える設定（prefers-reduced-motion）。
 *
 * 「所要時間を 0.01ms にする」だけだと、終わらないアニメーション
 * （回転・点滅）が 0.01ms の周期で回り続ける。動きは見えないのに
 * 毎秒10万回描き直そうとするので、電池と発熱にだけ効く。
 */
describe.skipIf(css == null)("動きを控える設定", () => {
  const block = (() => {
    const c = css ?? "";
    const i = c.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    if (i < 0) return "";
    const rest = c.slice(i + 20);
    const j = rest.search(/@media/);
    return j < 0 ? rest : rest.slice(0, j);
  })();

  it("そのブロックが出ている", () => {
    expect(block).not.toBe("");
  });

  it("繰り返しを1回で止める（0.01msで回し続けない）", () => {
    expect(block).toMatch(/animation-iteration-count:\s*1/);
  });

  it("待っている合図（回転）は残す", () => {
    // 止まった円は「控えた」ではなく「固まった」に見える。
    // 最小化で shorthand の順が入れ替わるので、名前と infinite で見る
    expect(block).toMatch(/\.animate-spin\{animation:[^}]*spin[^}]*\}/);
    expect(block).toMatch(/\.animate-spin\{animation:[^}]*infinite[^}]*\}/);
  });

  it("点滅は動かさず、薄いまま置く", () => {
    expect(block).toMatch(/animation:\s*none/);
  });

  it("スクロールも滑らかにしない", () => {
    expect(block).toMatch(/scroll-behavior:\s*auto/);
  });
});
