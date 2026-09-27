import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import type { MarkdownRenderer } from "../../app/lib/markdown-renderer.client";

/**
 * Markdown の描画の本体が**届くまで**と**届いた瞬間**。
 *
 * 本体（KaTeX・強調表示・生HTMLの消毒）は重いので、最初の読み込みから
 * 外して動的 import にしてある（`app/components/Markdown.tsx`）。その
 * 代わりに、届くまでのあいだの見え方がここで決まる:
 *
 *  - 空白にしない。空にすると画面が一瞬抜け、何も無い高さから本物へ飛ぶ。
 *  - 届いたら本物に替わる。替わり損ねると、記法（`**` や `|`）が見えた
 *    ままの本文が残る——エラーは出ないので気づけない。
 *  - 一度失敗しても、次に取り直す。
 *
 * 読み込み口を差し替えて、届くタイミングをテストの側で決める。ほかの
 * DOM テストは下ごしらえ（setup.ts）で本体を先に読むので、このファイル
 * だけは除いてある。
 */
const loader = vi.hoisted(() => ({
  calls: 0,
  next: null as null | (() => Promise<MarkdownRenderer>),
}));

vi.mock("../../app/lib/markdown-renderer.client", () => ({
  importMarkdownRenderer: () => {
    loader.calls += 1;
    return loader.next!();
  },
}));

const real = () =>
  vi.importActual<MarkdownRenderer>("../../app/components/MarkdownRenderer");

/** 手で解決する約束。届くタイミングをテストが決める。 */
function deferred() {
  let resolve!: (m: MarkdownRenderer) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<MarkdownRenderer>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 読み込みの状態はモジュールが持つので、テストごとに作り直す。 */
async function freshFacade() {
  vi.resetModules();
  return import("../../app/components/Markdown");
}

const SOURCE = "**強調** です。\n\n| 列 | 値 |\n|---|---|\n| a | 1 |";

beforeEach(() => {
  loader.calls = 0;
  loader.next = null;
});

describe("本体が届くまで", () => {
  it("記法を解釈しないまま、段落として本文を出す（空白にしない）", async () => {
    const pending = deferred();
    loader.next = () => pending.promise;
    const { Markdown } = await freshFacade();

    const { container } = render(<Markdown>{SOURCE}</Markdown>);
    const frame = container.firstElementChild as HTMLElement;
    // 枠は本物と同じ（入れ替わるときに枠ごと飛ばない）
    expect(frame.className).toContain("prose");
    // 本文は見えている。記法は解釈されていない
    expect(frame.querySelectorAll("p")).toHaveLength(2);
    expect(frame.textContent).toContain("**強調** です。");
    expect(frame.querySelector("strong")).toBeNull();
    expect(frame.querySelector("table")).toBeNull();
    // 描いた時点で取りに行っている
    expect(loader.calls).toBe(1);
  });

  it("届いたら本物に替わり、素の段落は残らない", async () => {
    const pending = deferred();
    loader.next = () => pending.promise;
    const { Markdown } = await freshFacade();

    const { container } = render(<Markdown>{SOURCE}</Markdown>);
    const frame = container.firstElementChild;
    expect(container.querySelector("strong")).toBeNull();

    await act(async () => pending.resolve(await real()));

    expect(container.querySelector("strong")?.textContent).toBe("強調");
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).not.toContain("**");
    // 枠の要素は同じもの（中身だけが入れ替わる）
    expect(container.firstElementChild).toBe(frame);
  });

  /**
   * 伸びている塊は、届くまでのあいだも描き直され続ける。画面翻訳に
   * 差し替えられた節点を React が触って落ちる事情は本物と同じなので、
   * 同じく翻訳の対象から外す（TRANSLATE_WHILE_GROWING）。
   */
  it("伸びている塊だけ、翻訳の対象から外す", async () => {
    loader.next = () => new Promise(() => {});
    const { MarkdownBody } = await freshFacade();

    const { container } = render(
      <div>
        <MarkdownBody>確定した段落</MarkdownBody>
        <MarkdownBody animate>伸びている段落</MarkdownBody>
      </div>,
    );
    const [settled, growing] = [...container.querySelectorAll("p")];
    expect(settled.textContent).toBe("確定した段落");
    expect(settled.getAttribute("translate")).toBeNull();
    expect(growing.textContent).toBe("伸びている段落");
    expect(growing.getAttribute("translate")).toBe("no");
  });

  it("取れなかったら、次に描くときに取り直す", async () => {
    const failed = deferred();
    loader.next = () => failed.promise;
    const { Markdown } = await freshFacade();

    const first = render(<Markdown>{SOURCE}</Markdown>);
    await act(async () => failed.reject(new Error("offline")));
    // 失敗しても本文は素の段落のまま見えている
    expect(first.container.textContent).toContain("**強調** です。");
    first.unmount();

    const ok = deferred();
    loader.next = () => ok.promise;
    const second = render(<Markdown>{SOURCE}</Markdown>);
    expect(loader.calls).toBe(2);
    await act(async () => ok.resolve(await real()));
    expect(second.container.querySelector("strong")).not.toBeNull();
  });
});

describe("useMarkdownReady（会話の画面が呼ぶ）", () => {
  /**
   * ホームは本文を描かないので、描いた時点で取りに行く経路には乗らない。
   * 最初の発言を送る前に届いているよう、画面が出て手が空いたら取りに行く。
   */
  it("本文が無くても、手が空いたら取りに行き、届いたら true になる", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred();
      loader.next = () => pending.promise;
      const { useMarkdownReady } = await freshFacade();

      const { result } = renderHook(() => useMarkdownReady());
      expect(result.current).toBe(false);
      // すぐには取りに行かない（ハイドレーション直後の操作と取り合わない）
      expect(loader.calls).toBe(0);

      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(loader.calls).toBe(1);
      expect(result.current).toBe(false);

      await act(async () => pending.resolve(await real()));
      expect(result.current).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
