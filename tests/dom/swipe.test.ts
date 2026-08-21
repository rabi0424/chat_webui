import { afterEach, describe, expect, it } from "vitest";
import { insideScrollableX } from "../../app/lib/swipe";

/**
 * 端からの払いを、横スクロールと取り違えない。
 *
 * 会話には横に長いものが載る——コードブロック、表、数式。左端から右へ
 * 払うとドロワーが開く仕掛けは、これらの上でも同じように効いていた。
 * 途中まで横に流して見ている最中に戻ろうとすると、**内容ではなく
 * ドロワーが出てくる**。
 */

/** jsdom は寸法を持たないので、必要な値だけ与える。 */
function box(opts: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  overflowX?: string;
}) {
  const el = document.createElement("div");
  el.style.overflowX = opts.overflowX ?? "auto";
  Object.defineProperty(el, "scrollLeft", { value: opts.scrollLeft });
  Object.defineProperty(el, "scrollWidth", { value: opts.scrollWidth });
  Object.defineProperty(el, "clientWidth", { value: opts.clientWidth });
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("横に流している最中か", () => {
  it("途中まで流していれば、そうと分かる", () => {
    const el = box({ scrollLeft: 40, scrollWidth: 800, clientWidth: 300 });
    expect(insideScrollableX(el)).toBe(true);
  });

  /** 左端まで戻り切っていれば、右へ払っても中身は動かない。 */
  it("左端まで戻っていれば、ドロワーに譲る", () => {
    const el = box({ scrollLeft: 0, scrollWidth: 800, clientWidth: 300 });
    expect(insideScrollableX(el)).toBe(false);
  });

  it("流す余地が無ければ、ドロワーに譲る", () => {
    const el = box({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
    expect(insideScrollableX(el)).toBe(false);
  });

  it("流せない箱（overflow が visible）は数えない", () => {
    const el = box({
      scrollLeft: 40,
      scrollWidth: 800,
      clientWidth: 300,
      overflowX: "visible",
    });
    expect(insideScrollableX(el)).toBe(false);
  });

  it("中の要素から始めても、親をたどって見つける", () => {
    const outer = box({ scrollLeft: 40, scrollWidth: 800, clientWidth: 300 });
    const code = document.createElement("code");
    outer.append(code);
    expect(insideScrollableX(code)).toBe(true);
  });

  it("どこにも無ければ false", () => {
    const plain = document.createElement("p");
    document.body.append(plain);
    expect(insideScrollableX(plain)).toBe(false);
  });

  it("要素でないものを渡しても落ちない", () => {
    expect(insideScrollableX(null)).toBe(false);
    expect(insideScrollableX(document)).toBe(false);
  });
});
