/**
 * DOMテストの下ごしらえ。
 *
 * jsdom はレイアウトを持たないので、実際の描画に関わる API がいくつか
 * 実装されていない。アプリ側は本物のブラウザで動くことを前提に書いて
 * よいので、足りないぶんはここで補う（挙動を変えるのではなく、
 * 呼ばれても落ちないようにするだけ）。
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
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
// 画像のプレビューURLに使う
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
