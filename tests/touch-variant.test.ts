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
