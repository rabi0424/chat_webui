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

/**
 * 操作アイコンの吹き出し（.tip::after）は、ポインタを載せられる端末で
 * だけ要素を作る。透明のまま置いておくだけでも幅を持ち、右端の操作から
 * 画面の外へはみ出して、iPhone で会話のフィードが左右に動いていた。
 *
 * 規則が @media (hover: hover) の外に出ると、その症状がそのまま戻る。
 * 見た目には何も出ないので、ビルド結果の入れ子を読んで確かめる。
 */
describe.skipIf(css == null)("吹き出しは hover のある端末だけ", () => {
  /**
   * hover 向けの手書き規則が、hover のメディアクエリの内側にあるか。
   *
   * 対象は `.tip::after`（吹き出し）と `.md-table-sortable:hover`（表の
   * 見出し）。Tailwind の `hover:` は `@media (hover:hover)` に包まれるが、
   * app.css に手で書いた `:hover` は包まれない。表の見出しは外に出ていて、
   * iPhone で並べ替えを押すと背景が残っていた（監査 D-19）。
   */
  function tipRulesOutsideHoverMedia(source: string): number {
    let outside = 0;
    const stack: string[] = [];
    let i = 0;
    while (i < source.length) {
      const open = source.indexOf("{", i);
      if (open < 0) break;
      const close = source.indexOf("}", i);
      if (close >= 0 && close < open) {
        stack.pop();
        i = close + 1;
        continue;
      }
      const head = source.slice(i, open).trim();
      // 規則の中身の途中（宣言）で "{" を見ることは無いので、
      // ここに来る head は必ずセレクタか @ルール
      // 最小化で `::after` は `:after` に縮むので、どちらも見る
      if (
        /\.tip(?::hover|:focus-visible)?::?after/.test(head) ||
        /\.md-table-sortable:hover/.test(head)
      ) {
        const inHover = stack.some((s) => /@media[^{]*hover:\s*hover/.test(s));
        if (!inHover) outside++;
      }
      stack.push(head);
      i = open + 1;
    }
    return outside;
  }

  it("吹き出しの規則が1つ以上出ていて、すべて hover の中にある", () => {
    expect(css).toMatch(/\.tip::?after/);
    expect(css).toMatch(/\.md-table-sortable:hover/);
    expect(tipRulesOutsideHoverMedia(css!)).toBe(0);
  });

  it("検査そのものが効いている（外に出た規則を数えられる）", () => {
    const bad = "@media (hover:hover){.a{x:1}}.tip::after{content:''}";
    expect(tipRulesOutsideHoverMedia(bad)).toBe(1);
    const good = "@media (hover:hover){.tip::after{content:''}.tip:hover::after{opacity:1}}";
    expect(tipRulesOutsideHoverMedia(good)).toBe(0);
    expect(tipRulesOutsideHoverMedia(".prose th.md-table-sortable:hover{x:1}")).toBe(1);
  });
});

/**
 * 面と文字のトークン（UI-10）とフォーカスの輪。
 *
 * `@theme inline` で束ねた色は、綴りを違えても Tailwind は黙って
 * 規則を出さない（`text-ink-2` が効かなければ文字は継承色になるだけで、
 * 画面は一見ふつうに見える）。輪も、キーボードで辿らないと見ないので、
 * 規則が出ていることをビルド結果で見る。
 */
describe.skipIf(css == null)("面と文字のトークン", () => {
  it("トークンの utility が CSS 変数を引いている", () => {
    for (const [cls, v] of [
      ["text-ink-2", "--ink-2"],
      ["text-ink-3", "--ink-3"],
      ["bg-sunken", "--sunken"],
      ["border-line", "--line"],
      ["hover\\\\:bg-hover", "--hover"],
    ]) {
      expect(css, cls).toMatch(new RegExp(`\\.${cls}[^{]*\\{[^}]*var\\(${v}\\)`));
    }
  });

  it("ダークでは値が入れ替わる", () => {
    const dark = css!.match(/:root\.dark\{[^}]*\}/g)?.join("\n") ?? "";
    expect(dark).toContain("--ink-2:#a3a3a3");
    expect(dark).toContain("--surface:#0a0a0a");
  });

  it("押せるものにアクセント色の輪が出る", () => {
    const rule = css!.match(/:where\(a,button[^{]*\):focus-visible\{[^}]*\}/)?.[0];
    expect(rule).toBeDefined();
    expect(rule).toContain("outline:2px solid var(--accent)");
    // 入力欄は含めない（枠の色で示す）
    expect(rule).not.toContain("input");
  });
});
