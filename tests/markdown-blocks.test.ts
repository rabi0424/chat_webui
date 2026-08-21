import { describe, expect, it } from "vitest";
import { splitBlocks } from "../app/lib/markdown-blocks";

/**
 * ストリーミング中の描画は、確定した部分と書きかけの部分に切って
 * 分けて描く。切り方を誤ると、コードや表や数式の途中で切れて
 * 表示が崩れる（見出しが巨大化する、コードが本文として出る等）。
 */
describe("splitBlocks", () => {
  it("空行で段落を分ける", () => {
    expect(splitBlocks("段落1\n\n段落2")).toEqual(["段落1\n\n", "段落2"]);
  });

  it("空文字は空の配列", () => {
    expect(splitBlocks("")).toEqual([]);
  });

  it("コードフェンスの中では分けない", () => {
    const src = "```js\nconst a = 1;\n\nconst b = 2;\n```";
    expect(splitBlocks(src)).toEqual([src]);
  });

  it("チルダのフェンスも同じ扱い", () => {
    const src = "~~~py\nx = 1\n\ny = 2\n~~~";
    expect(splitBlocks(src)).toEqual([src]);
  });

  it("フェンスの中に別のフェンス記号があっても切らない", () => {
    const src = "````md\n```js\nconst a = 1;\n```\n\n続き\n````";
    expect(splitBlocks(src)).toEqual([src]);
  });

  it("数式ブロックの中では分けない", () => {
    const src = "$$\na = 1\n\nb = 2\n$$";
    expect(splitBlocks(src)).toEqual([src]);
  });

  it("表は途中で切らない", () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |";
    const parts = splitBlocks(src);
    expect(parts.join("")).toBe(src);
    expect(parts).toHaveLength(1);
  });

  it("分けても元の本文に戻る（取りこぼしも重複もない）", () => {
    const samples = [
      "見出し\n\n本文です。\n\n- 箇条書き\n- 2つ目\n",
      "```js\ncode\n```\n\nあとの文\n\n$$x^2$$\n",
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n次の段落\n",
      "\n\n\n先頭に空行\n\n\n末尾にも空行\n\n\n",
      "改行なしの1行だけ",
      "<div>\nHTML\n</div>\n\n本文\n",
    ];
    for (const src of samples) {
      expect(splitBlocks(src).join(""), JSON.stringify(src)).toBe(src);
    }
  });
});
