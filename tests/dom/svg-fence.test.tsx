import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { Markdown } from "../../app/components/Markdown";

/**
 * どの言語のコードブロックを SVG の図として扱うか。
 *
 * モデルは同じ SVG を色々な名前のフェンスで返してくる。`svg` と `xml` しか
 * 見ていなかったので、`html` で返された図がソースのまま表示されていた
 * ——利用者からは「描画されない」としか見えず、原因も分からない。
 *
 * 広げすぎると逆に危ない（本物の HTML 文書や設定ファイルの XML を図に
 * してしまう）ので、**中身が `<svg` で始まるか**の判定と両方を見る。
 */

const FIGURE = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

function block(lang: string, body: string) {
  const { container } = render(
    <Markdown>{"```" + lang + "\n" + body + "\n```"}</Markdown>,
  );
  return container;
}

/** 図になっていれば SvgBlock のツールバー（「SVG」ボタン）が出る。 */
const isFigure = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("button")).some((b) =>
    (b.textContent ?? "").startsWith("SVG"),
  );

describe("SVG として扱うフェンス", () => {
  for (const lang of ["svg", "xml", "html", "xhtml", "svg+xml", "markup"]) {
    it(`\`\`\`${lang} の SVG は図になる`, async () => {
      const c = block(lang, FIGURE);
      await waitFor(() => expect(isFigure(c)).toBe(true));
    });
  }

  it("大文字で書かれていても図になる", async () => {
    const c = block("SVG", FIGURE);
    await waitFor(() => expect(isFigure(c)).toBe(true));
  });
});

describe("図にしないもの", () => {
  it("本物の HTML 文書は図にしない（コードのまま）", async () => {
    const c = block("html", "<!DOCTYPE html>\n<html><body>やあ</body></html>");
    // 図にならないことと、コードとして読めることを対で見る
    await waitFor(() => expect(c.textContent).toContain("DOCTYPE"));
    expect(isFigure(c)).toBe(false);
  });

  it("SVG でない XML は図にしない", async () => {
    const c = block("xml", "<config><name>設定</name></config>");
    await waitFor(() => expect(c.textContent).toContain("設定"));
    expect(isFigure(c)).toBe(false);
  });

  it("SVG を含むだけの HTML 断片は図にしない（先頭で判断する）", async () => {
    const c = block("html", `<div>説明</div>\n${FIGURE}`);
    await waitFor(() => expect(c.textContent).toContain("説明"));
    expect(isFigure(c)).toBe(false);
  });

  it("関係のない言語は図にしない", async () => {
    const c = block("javascript", FIGURE);
    await waitFor(() => expect(c.textContent).toContain("circle"));
    expect(isFigure(c)).toBe(false);
  });
});
