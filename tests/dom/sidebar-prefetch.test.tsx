import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import {
  noteConversations,
  PREFETCH_CONCURRENCY,
  resetChatCache,
} from "../../app/lib/chat-cache";
import { conv, renderSidebar } from "./helpers/sidebar-harness";

/**
 * サイドバーの行の先読み。
 *
 * 以前は行ごとに IntersectionObserver を作り、最初に見えた時点で外して
 * いた。ドロワーを開くと20行ぶんの「会話を丸ごと」の要求が同時に飛んで
 * 押した会話の読み込みと競り、60秒で写しが捨てられた後は二度と取り
 * 直されず、押すたびにサーバーを待っていた。
 *
 * jsdom には交差の判定が無いので、見えた・外れたを手で起こせる監視に
 * 差し替える。監視はモジュールの中で1つだけ作られるので、このファイル
 * では最初の描画より前に差し替えておく。
 */
const observers: FakeObserver[] = [];
class FakeObserver {
  targets = new Set<Element>();
  constructor(private cb: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords() {
    return [];
  }
  /** 渡した要素が見えた（または外れた）ことにする。 */
  fire(els: Element[], isIntersecting: boolean) {
    this.cb(
      els.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}
globalThis.IntersectionObserver =
  FakeObserver as unknown as typeof IntersectionObserver;

/** 先読みの返事は止めておく（同時に何本出ているかを数えるため）。 */
let opened: string[];
let release: (() => void)[];
beforeEach(() => {
  resetChatCache();
  opened = [];
  release = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    const id = path.split("/")[3];
    if (!path.endsWith("/full")) {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    opened.push(id);
    return new Promise<Response>((resolve) => {
      release.push(() =>
        resolve(
          new Response(
            JSON.stringify({
              conversation: { id, title: id, updated_at: 1_700_000_000_000 },
              messages: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );
    });
  }) as typeof fetch;
});
afterEach(() => resetChatCache());

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const rowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => conv(`c${i}`, `会話${i}`));
const li = (title: string) => screen.getByText(title).closest("li") as HTMLElement;

describe("行の先読み", () => {
  it("監視は全行で1つ、見えた行を一度に取りに行かない", async () => {
    renderSidebar({ conversations: rowsOf(20) });
    const io = observers.at(-1)!;
    // 行ごとに監視を作らない
    expect(observers).toHaveLength(1);
    expect(io.targets.size).toBe(20);

    act(() => io.fire([...io.targets], true));
    expect(opened).toHaveLength(PREFETCH_CONCURRENCY);
    // 見えた順に
    expect(opened).toEqual(["c0", "c1"]);

    // 返るたびに次へ
    release[0]();
    await flush();
    expect(opened).toEqual(["c0", "c1", "c2"]);
  });

  it("画面から出た行の、まだ投げていない先読みは取り下げる", async () => {
    renderSidebar({ conversations: rowsOf(6) });
    const io = observers.at(-1)!;
    act(() => io.fire([...io.targets], true));
    act(() => io.fire([li("会話2"), li("会話3")], false));
    for (let i = 0; i < 6; i++) {
      release[i]?.();
      await flush();
    }
    expect(opened).toEqual(["c0", "c1", "c4", "c5"]);
  });

  it("ポインタが乗った行は、並んでいるものより先に取る", async () => {
    renderSidebar({ conversations: rowsOf(10) });
    const io = observers.at(-1)!;
    act(() => io.fire([...io.targets], true));
    fireEvent.pointerEnter(li("会話8"));
    release[0]();
    await flush();
    expect(opened[PREFETCH_CONCURRENCY]).toBe("c8");
  });

  it("取ってある写しが一覧に追い越されていたら、ポインタが乗った時点で取り直す", async () => {
    renderSidebar({ conversations: rowsOf(1) });
    const io = observers.at(-1)!;
    act(() => io.fire([...io.targets], true));
    release[0]();
    await flush();
    expect(opened).toEqual(["c0"]);

    // 新しいうちは取りに行かない
    fireEvent.pointerEnter(li("会話0"));
    fireEvent.focusIn(li("会話0"));
    expect(opened).toEqual(["c0"]);

    // 別の端末で進んだ
    noteConversations([{ id: "c0", updated_at: 1_700_000_000_001 }]);
    fireEvent.pointerEnter(li("会話0"));
    expect(opened).toEqual(["c0", "c0"]);
  });

  it("外れた行は監視からも外す", () => {
    const { unmount } = renderSidebar({ conversations: rowsOf(3) });
    const io = observers.at(-1)!;
    expect(io.targets.size).toBe(3);
    unmount();
    expect(io.targets.size).toBe(0);
  });
});
