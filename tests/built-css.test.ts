import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 素の CSS プロパティを Tailwind の任意指定（`[prop:value]`）で書いたとき、
 * 本当に規則が出ているか。
 *
 * Tailwind はクラス名を受け付けなかったとき、**何も言わずにその規則を
 * 出さないだけ**で終わる。型チェックもテストも通り、画面も一見ふつうに
 * 出る——効いていないことに気づく手がかりが無い。効きの有無が見た目に
 * 出ないもの（描画の間引きなど）は、なおさら分からない。ここはビルド
 * 結果を直接読む。
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

const css = builtCss();

// ビルドしていない環境（テストだけ流す場合）では飛ばす
describe.skipIf(css == null)("任意指定のプロパティ", () => {
  /**
   * 画像一覧のマスは、画面の外に出ているあいだ中身の組み立てを飛ばす。
   * スクロールで足していく一覧なので枚数は数百に達し、画面外のぶんも
   * 毎回レイアウトと描画の対象になっていた。
   *
   * 効かなくなっても画面は同じに見える（ただ重くなる）ので、規則が
   * 出ていることをここで見る。
   */
  it("画面外のマスを飛ばす指定が出ている", () => {
    expect(css).toContain("content-visibility:auto");
  });
});
