import { describe, expect, it } from "vitest";

/**
 * 図の入れ物（host）が張り替わったときの ShadowRoot の扱い。
 *
 * SvgBlock はソース表示との切り替えで <div> と <pre> を行き来するため、
 * React は図の入れ物を使い回さず作り直す。shadow を一度しか作らないと、
 * 切り離された古い ShadowRoot に書き続けることになり、図に戻したときに
 * 何も出なくなる（E-1）。SvgBlock の attachHost と同じ手順を置いて、
 * 要素が入れ替わっても描けることを確かめる。
 */
const STYLE = "svg{max-width:100%}";

/** 修正前: shadow を一度だけ作る */
function makeOld() {
  const host: { current: HTMLDivElement | null } = { current: null };
  const shadow: { current: ShadowRoot | null } = { current: null };
  return {
    setHost: (el: HTMLDivElement | null) => {
      host.current = el;
    },
    draw: (svg: string) => {
      if (!host.current) return;
      shadow.current ??= host.current.attachShadow({ mode: "open" });
      shadow.current.innerHTML = `<style>${STYLE}</style>${svg}`;
    },
    shadow,
  };
}

/** 修正後: 要素が変わったら作り直す */
function makeNew() {
  const host: { current: HTMLDivElement | null } = { current: null };
  const shadow: { current: ShadowRoot | null } = { current: null };
  return {
    setHost: (el: HTMLDivElement | null) => {
      if (el === host.current) return;
      host.current = el;
      shadow.current = el
        ? (el.shadowRoot ?? el.attachShadow({ mode: "open" }))
        : null;
    },
    draw: (svg: string) => {
      const root = shadow.current;
      if (!svg || !root) return;
      root.innerHTML = `<style>${STYLE}</style>${svg}`;
    },
    shadow,
  };
}

const SVG = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

/** 図を表示 → ソース表示 → 図に戻す、という操作を再現する */
function toggleCycle(impl: ReturnType<typeof makeNew>) {
  const container = document.createElement("div");
  document.body.appendChild(container);

  // 図を表示（入れ物をマウント）
  const first = document.createElement("div");
  container.appendChild(first);
  impl.setHost(first);
  impl.draw(SVG);
  const drawnFirst = first.shadowRoot?.querySelector("svg") != null;

  // ソース表示へ（入れ物がアンマウントされる）
  container.removeChild(first);
  impl.setHost(null);

  // 図に戻す（React は新しい要素を作る）
  const second = document.createElement("div");
  container.appendChild(second);
  impl.setHost(second);
  impl.draw(SVG);
  const drawnSecond = second.shadowRoot?.querySelector("svg") != null;

  document.body.removeChild(container);
  return { drawnFirst, drawnSecond };
}

describe("ソース表示と図の行き来", () => {
  it("修正前は、図に戻したときに空白になる", () => {
    const r = toggleCycle(makeOld() as ReturnType<typeof makeNew>);
    expect(r.drawnFirst, "最初は描けている").toBe(true);
    expect(r.drawnSecond, "戻したときに描けていない＝報告された症状").toBe(false);
  });

  it("修正後は、図に戻しても描ける", () => {
    const r = toggleCycle(makeNew());
    expect(r.drawnFirst).toBe(true);
    expect(r.drawnSecond).toBe(true);
  });

  it("何度往復しても描ける", () => {
    const impl = makeNew();
    for (let i = 0; i < 5; i++) {
      const r = toggleCycle(impl);
      expect(r.drawnSecond, `${i + 1}回目`).toBe(true);
    }
  });

  it("同じ要素を渡し直しても attachShadow で落ちない", () => {
    const impl = makeNew();
    const el = document.createElement("div");
    impl.setHost(el);
    // 同じ要素に二度目（React が同じ node を渡してくることがある）
    expect(() => impl.setHost(el)).not.toThrow();
    impl.draw(SVG);
    expect(el.shadowRoot?.querySelector("svg")).not.toBeNull();
  });

  it("既に shadow の付いた要素を渡されても作り直さない", () => {
    const impl = makeNew();
    const el = document.createElement("div");
    const pre = el.attachShadow({ mode: "open" });
    expect(() => impl.setHost(el)).not.toThrow();
    expect(impl.shadow.current).toBe(pre);
  });

  it("入れ物が無いあいだは描こうとしない", () => {
    const impl = makeNew();
    impl.setHost(null);
    expect(() => impl.draw(SVG)).not.toThrow();
  });
});
