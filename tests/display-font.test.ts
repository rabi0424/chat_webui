import { beforeEach, describe, expect, it } from "vitest";

import {
  DISPLAY_FONT_CSS_ORIGIN,
  DISPLAY_FONT_CSS_URL,
  loadDisplayFont,
} from "../app/lib/display-font";

/**
 * 見出しの書体の CSS は、描いたあとにスクリプトから差し込む
 * （<head> に直に置くと最初の描画が止まる。lib/display-font.ts）。
 */
const links = () =>
  Array.from(
    document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  );

beforeEach(() => {
  document.head.innerHTML = "";
});

describe("見出しの書体の読み込み", () => {
  it("書体の CSS を stylesheet として差し込む", () => {
    loadDisplayFont();
    expect(links()).toHaveLength(1);
    expect(links()[0].href).toBe(DISPLAY_FONT_CSS_URL);
  });

  /**
   * 開発時の StrictMode は effect を2回走らせ、Layout はエラー画面でも
   * 描かれる。そのたびに増えると、同じ 200KB 余りの CSS を何度も解釈する。
   */
  it("何度呼んでも1本だけ", () => {
    loadDisplayFont();
    loadDisplayFont();
    loadDisplayFont();
    expect(links()).toHaveLength(1);
  });

  it("ほかの stylesheet があっても差し込む", () => {
    const own = document.createElement("link");
    own.rel = "stylesheet";
    own.href = "/assets/root.css";
    document.head.appendChild(own);
    loadDisplayFont();
    expect(links().map((l) => l.href)).toEqual([
      "http://localhost:3000/assets/root.css",
      DISPLAY_FONT_CSS_URL,
    ]);
  });

  it("届くまではシステム書体で描き、届いたら差し替える（display=swap）", () => {
    // swap でないと、届くまで見出しの文字そのものが見えない
    expect(new URL(DISPLAY_FONT_CSS_URL).searchParams.get("display")).toBe("swap");
    expect(DISPLAY_FONT_CSS_ORIGIN).toBe("https://fonts.googleapis.com");
  });
});
