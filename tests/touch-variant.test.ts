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

/**
 * 読み上げ専用の領域（監査 F-20）。
 *
 * 生成の開始・完了・失敗は sr-only の中に書いている。ここが
 * display:none や visibility:hidden で隠されると、**画面上の見え方は
 * 同じまま**、支援技術からだけ消える——読み上げが止まったことに
 * 気づく手段が無いので、出力を見て確かめる。
 */
describe.skipIf(css == null)("読み上げ専用の隠し方", () => {
  const rule = /\.sr-only\{([^}]*)\}/.exec(css ?? "")?.[1] ?? "";

  it("規則そのものが出ている", () => {
    // クラス名を間違えると Tailwind は黙って何も出さない。
    // そのときは読み上げ用の文言が画面に居座る
    expect(rule).not.toBe("");
  });

  it("読み上げから消える隠し方をしていない", () => {
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
    expect(rule).not.toMatch(/content-visibility:\s*hidden/);
  });

  it("画面からは見えない大きさに畳んである", () => {
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/width:\s*1px/);
    expect(rule).toMatch(/height:\s*1px/);
  });
});

/**
 * 生成中の会話（サイドバーのタイトルを流れる光）。
 *
 * 文字を透明にして背景を文字型で切り抜く作りなので、切り抜きが効かない
 * 環境ではタイトルが**丸ごと消える**。効くと分かってから切り替えている
 * ——が、それは出力を見ないと確かめられない（ソースを読んでも、
 * 束ね方しだいで @supports の外に出ていないとは言い切れない）。
 */
describe.skipIf(css == null)("生成中のタイトル", () => {
  const c = css ?? "";
  /** @supports の中に入っている規則。 */
  const supported =
    /@supports\s*\([^{]*background-clip:\s*text[^{]*\{([^}]*\{[^}]*\})*\}/.exec(
      c,
    )?.[0] ?? "";

  it("切り抜きが効く環境だけ、文字を透明にする", () => {
    expect(supported).toContain(".title-shimmer");
    // #0000 は minify 後の transparent
    expect(supported).toMatch(/color:\s*(#0000|transparent)/);
    expect(supported).toMatch(/background-clip:\s*text/);
    expect(supported).toMatch(/animation:[^}]*title-shimmer/);
  });

  it("透明にする指定が @supports の外へ漏れていない", () => {
    // 漏れると、切り抜けない環境でタイトルが消える
    const outside = c.replace(supported, "");
    const leaked = /\.title-shimmer\{[^}]*color:\s*(#0000|transparent)/.exec(
      outside,
    );
    expect(leaked).toBeNull();
  });

  it("切り抜けない環境でも読める色を先に置く", () => {
    const outside = c.replace(supported, "");
    expect(outside).toMatch(/\.title-shimmer\{color:var\(--shimmer-glow\)\}/);
    // 光の色は明暗どちらでも定義してある（片方だけだと地に溶ける）
    expect(c).toMatch(/--shimmer-base:/);
    expect(c).toMatch(/\.dark[^{]*\{[^}]*--shimmer-glow:/);
  });

  it("動きを控える設定では、帯を流さず濃い色で置く", () => {
    // 止めた帯をそのまま残すと、切り抜いた文字がグラデーションの端の色で
    // 描かれ、どこで止まるかによっては読めない濃さになる
    const i = c.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    const block = i < 0 ? "" : c.slice(i);
    const rule = /\.title-shimmer\{([^}]*)\}/.exec(block)?.[1] ?? "";
    expect(rule).toMatch(/animation:\s*none/);
    expect(rule).toMatch(/background-image:\s*none/);
    expect(rule).toMatch(/color:\s*var\(--shimmer-glow\)/);
  });
});
