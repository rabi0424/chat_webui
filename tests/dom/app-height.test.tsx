import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import Shell from "../../app/routes/shell";
import { Row } from "../../app/components/controls";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";

/**
 * アプリの高さ（--app-height）の当て方と、それを狂わせた要素。
 *
 * 設定画面で、画面全体が崩れてドロワーが背景の無い部品だけになった。
 * 原因は2つの組み合わせ:
 *
 * 1. 「保存しました」の印は出していないとき sr-only（absolute）で、位置の
 *    基準になる祖先が無く、画面全体を基準に置かれて文書を 4000px 近くまで
 *    伸ばしていた。
 * 2. 高さの補正が**文書全体の**はみ出しを差し引いていたので、高さが負に
 *    なった。負の height は無効なので箱が中身の高さまで伸び、文書がさらに
 *    はみ出して戻れなくなる。
 *
 * jsdom はレイアウトしないので、寸法は差し替えて与える。実物の崩れは
 * Chromium（iPhone の幅）で再現し、直ったことも同じ手順で確かめた。
 */

const VIEWPORT = 664;
const html = document.documentElement;

/** いま当たっている --app-height（px）。未設定なら VIEWPORT。 */
function appHeightPx(): number {
  const v = html.style.getPropertyValue("--app-height");
  return v.endsWith("px") ? parseFloat(v) : VIEWPORT;
}

function stubLayout(opts: { measured: number; clientHeight: number; docScrollHeight: number }) {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      height: opts.measured,
      scale: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  Object.defineProperty(html, "clientHeight", { configurable: true, get: () => opts.clientHeight });
  // 文書全体の高さは、箱の外の要素に伸ばされている想定（箱の高さと無関係）
  Object.defineProperty(html, "scrollHeight", {
    configurable: true,
    get: () => Math.max(opts.docScrollHeight, appHeightPx()),
  });
  // アプリの箱（lang="ja" の外枠）の下端は、当たっている高さそのもの
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const bottom = this.getAttribute("lang") === "ja" ? appHeightPx() : 0;
    return { top: 0, left: 0, right: 0, bottom, width: 0, height: bottom, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
}

async function renderShell() {
  const loaderData = {
    conversations: [],
    bots: [],
    folders: [],
    settings: DEFAULT_APP_SETTINGS,
    now: Date.now(),
  };
  const Stub = createRoutesStub([
    {
      path: "/",
      loader: () => loaderData,
      Component: () => <Shell {...({ loaderData } as never)} />,
      children: [{ index: true, Component: () => <p data-testid="page">page</p> }],
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  await screen.findByTestId("page");
}

beforeEach(() => {
  localStorage.clear();
  html.style.removeProperty("--app-height");
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ids: [], generating: [], latest: 0, models: [], usdJpy: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { visualViewport?: unknown }).visualViewport;
  delete (html as { clientHeight?: unknown }).clientHeight;
  delete (html as { scrollHeight?: unknown }).scrollHeight;
  html.style.removeProperty("--app-height");
});

describe("アプリの高さの補正", () => {
  it("箱の外の要素が文書を伸ばしていても、高さを縮めない", async () => {
    // 文書は 300px はみ出しているが、箱は画面ちょうど。以前は 300px
    // 差し引いて 364px にしていた（はみ出しが実測値を越えると負になる）
    stubLayout({ measured: VIEWPORT, clientHeight: VIEWPORT, docScrollHeight: VIEWPORT + 300 });
    await renderShell();
    expect(html.style.getPropertyValue("--app-height")).toBe(`${VIEWPORT}px`);
  });

  it("箱そのものがはみ出したぶんは、今までどおり縮める", async () => {
    // Safari の実測値が文書の表示範囲より 20px 大きい場合（直した元の症状）
    stubLayout({ measured: 712, clientHeight: 692, docScrollHeight: 0 });
    await renderShell();
    expect(html.style.getPropertyValue("--app-height")).toBe("692px");
  });
});

describe("「保存しました」の印", () => {
  it("隠れているあいだ（sr-only）も、行の中を基準に置かれる", () => {
    const { container } = render(
      <Row label="待つ時間" saved={false}>
        <input aria-label="待つ時間" />
      </Row>,
    );
    const row = container.firstElementChild as HTMLElement;
    const mark = row.querySelector("[aria-live]") as HTMLElement;
    // 印は隠れた形で置かれている（出している形なら基準は問題にならない）
    expect(mark.className).toContain("sr-only");
    // 行（またはその中）に位置の基準がある。無いと画面全体が基準になり、
    // 下のほうの行の印が文書を伸ばす
    const anchor = mark.parentElement?.closest(".relative, .absolute, .fixed, .sticky");
    expect(anchor).not.toBeNull();
    expect(row.contains(anchor!)).toBe(true);
    // 行そのものは描かれている
    expect(screen.getByLabelText("待つ時間")).toBeInTheDocument();
  });
});
