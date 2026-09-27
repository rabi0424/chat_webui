/**
 * DOMテストの下ごしらえ。
 *
 * jsdom はレイアウトを持たないので、実際の描画に関わる API がいくつか
 * 実装されていない。アプリ側は本物のブラウザで動くことを前提に書いて
 * よいので、足りないぶんはここで補う（挙動を変えるのではなく、
 * 呼ばれても落ちないようにするだけ）。
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, expect, vi } from "vitest";
import { cleanup } from "@testing-library/react";

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
    root = null;
    rootMargin = "";
    thresholds = [];
  } as unknown as typeof IntersectionObserver;
}
// 拡大表示は指を1本つかんで追う（払いと移動の判定）。jsdom には無い
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  Element.prototype.hasPointerCapture = function hasPointerCapture() {
    return false;
  };
}

// 画像のプレビューURLに使う
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/*
 * Markdown の描画の本体はあとから読み込む（app/components/Markdown.tsx）。
 * 届くまでは記法を解釈しない素の段落が出るので、届く前に文字だけを見る
 * テストは、**本物の描画を見ないまま通ってしまう**（実際に、囲みの文字が
 * 描画後にも残るかを見るテストが、素の段落の文字で通っていた）。
 * どのテストも、本体が届いた状態——以前の静的 import と同じ状態——から
 * 始める。
 *
 * 届く前の振る舞いそのものを見るファイルだけは除く。そちらは読み込み口を
 * 差し替えて、届くタイミングを自分で決める（先に本物を読むと差し替えが
 * 効かない）。
 */
const LAZY_MARKDOWN_TESTS = ["markdown-lazy.test.tsx"];
beforeAll(async () => {
  const path = expect.getState().testPath ?? "";
  if (LAZY_MARKDOWN_TESTS.some((name) => path.endsWith(name))) return;
  const { preloadMarkdown } = await import("../../app/components/Markdown");
  if (!(await preloadMarkdown())) {
    throw new Error("Markdown の描画の本体を読み込めなかった");
  }
});
