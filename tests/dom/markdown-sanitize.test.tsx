import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "../../app/components/Markdown";

/**
 * 本文の消毒（監査 X-2）と、そのせいで機能を壊していないかの確認。
 *
 * 本文はモデルの出力なので、生HTMLはサニタイズを通してから描く。以前は
 * `class` を**全要素・全値**で許していた。この画面は Tailwind を使うので、
 * `<div class="fixed inset-0 z-50 bg-white">` と書くだけで会話の画面を
 * 全面が覆える——利用者はそれをアプリの一部として読むので、偽の対話箱で
 * 何でも聞き出せる。
 *
 * ただし絞りすぎると、数式・警告ブロック・脚注が黙って壊れる（どれも
 * クラスを頼りに後段が動く）。落とすことと残すことを両方見る。
 */
const markdown = (source: string) => {
  const { container } = render(<Markdown>{source}</Markdown>);
  return container;
};

describe("危ないクラスを落とす", () => {
  it("画面を覆うクラスは通さない（偽の対話箱を描けない）", () => {
    const container = markdown(
      '<div class="fixed inset-0 z-50 bg-white">パスワードを入力してください</div>',
    );
    const div = container.querySelector(".prose > div");
    // 中身は残る（描けなくなっているのではなく、クラスだけが落ちている）
    expect(container.textContent).toContain("パスワードを入力してください");
    expect(div).not.toBeNull();
    expect(div?.className).toBe("");
  });

  it("見出しや段落に勝手なクラスを付けられない", () => {
    const container = markdown(
      '<p class="fixed inset-0 bg-white">本文</p>' +
        '<span class="absolute top-0">脇</span>',
    );
    expect(container.textContent).toContain("本文");
    expect(container.querySelector("p")?.className).toBe("");
    expect(container.querySelector("span")?.className).toBe("");
  });

  it("style 属性も通さない（クラス以外の抜け道）", () => {
    const container = markdown(
      '<div style="position:fixed;inset:0;background:#fff">覆う</div>',
    );
    expect(
      container.querySelector(".prose > div")?.getAttribute("style"),
    ).toBeNull();
  });
});

describe("描画に要るクラスは残る", () => {
  /**
   * `math-inline` / `math-display` と `language-math` は、rehype-katex から
   * 見ると**どちらか片方あれば同じ結果**になる（インライン/ブロックの別も
   * 親が `<pre>` かで決まる）。そのため片方だけ落としても描画は変わらず、
   * テストで区別できない。ここで見張れるのは「code のクラスが丸ごと
   * 落ちたら数式が消える」ところまで。
   */
  it("数式が描ける（remark-math の印が消えていない）", () => {
    const container = markdown("インライン $x^2$ と\n\n$$\n\\frac{a}{b}\n$$\n");
    // KaTeX が実際に描いた結果を見る（印だけ残っていても描けなければ意味が無い）
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("警告ブロックが枠になる", () => {
    const container = markdown("> [!NOTE]\n> 補足の説明。\n");
    expect(container.querySelector(".md-alert-note")).not.toBeNull();
    expect(container.textContent).toContain("メモ");
    expect(container.textContent).toContain("補足の説明。");
  });

  it("脚注が脚注として出る", () => {
    const container = markdown("本文[^1]\n\n[^1]: 注記\n");
    expect(container.querySelector("section.footnotes")).not.toBeNull();
    expect(container.querySelector("h2.sr-only")).not.toBeNull();
    // 戻りリンク（クラスは描画側で落としているので、行き先で見る）
    expect(
      container.querySelector('a[href="#user-content-fnref-1"]'),
    ).not.toBeNull();
  });

  it("コードブロックの言語が残る（見出しと色付けの手がかり）", () => {
    const container = markdown("```js\nconst a = 1;\n```\n");
    const code = container.querySelector("code");
    expect(code?.className).toContain("language-js");
    expect(container.textContent).toContain("JavaScript");
  });

  it("チェックリストの印が残る", () => {
    const container = markdown("- [ ] やること\n- [x] 済み\n");
    expect(container.querySelector("ul.contains-task-list")).not.toBeNull();
    expect(container.querySelectorAll("li.task-list-item")).toHaveLength(2);
  });
});
