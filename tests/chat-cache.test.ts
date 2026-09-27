import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPrefetch,
  getCachedChat,
  invalidateChat,
  MAX_AGE_MS,
  noteConversations,
  pendingChat,
  PREFETCH_CONCURRENCY,
  prefetchChat,
  putCachedChat,
  resetChatCache,
  type ChatData,
} from "../app/lib/chat-cache";

/**
 * 会話の先読みキャッシュ。
 *
 * 古い内容を掴んだまま返すと、生成が進んだ会話を開いても止まって
 * 見えたり、変更した設定が巻き戻って見えたりする。「いつ捨てるか」を
 * 押さえる。
 */
const data = (title: string, updatedAt = 1_000) =>
  ({
    conversation: { id: "c1", title, updated_at: updatedAt },
    messages: [],
  }) as unknown as ChatData;

describe("chat-cache", () => {
  beforeEach(() => {
    vi.useRealTimers();
    // 各テストの前に、使うIDを空にしておく
    for (const id of ["c1", "c2", "c3"]) invalidateChat(id);
  });

  it("入れたものを返す", () => {
    putCachedChat("c1", data("元のタイトル"));
    expect(getCachedChat("c1")?.conversation.title).toBe("元のタイトル");
  });

  it("知らないIDは null", () => {
    expect(getCachedChat("知らないID")).toBeNull();
  });

  it("捨てたら返さない", () => {
    putCachedChat("c1", data("x"));
    invalidateChat("c1");
    expect(getCachedChat("c1")).toBeNull();
  });

  /**
   * 鮮度は一覧の更新時刻で決める（下の「別の端末で進んだ会話」）。
   * 以前の60秒では、一覧を1分眺めてから押すとどの会話もサーバーを
   * 待っていた。
   */
  it("60秒を過ぎても、一覧が追い越していなければ返す", () => {
    vi.useFakeTimers();
    putCachedChat("c1", data("x"));
    vi.advanceTimersByTime(61_000);
    expect(getCachedChat("c1")).not.toBeNull();
    vi.useRealTimers();
  });

  /**
   * 枝の切り替えやモデルの変更は updated_at を動かさないので、一覧の
   * 時刻では分からない。その食い違いが残る長さには上限を置く。
   */
  it("上限の時間を過ぎたら返さない", () => {
    vi.useFakeTimers();
    putCachedChat("c1", data("x"));
    vi.advanceTimersByTime(MAX_AGE_MS - 1_000);
    expect(getCachedChat("c1")).not.toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(getCachedChat("c1")).toBeNull();
    vi.useRealTimers();
  });

  it("入れ直すと時計も鮮度も新しくなる", () => {
    vi.useFakeTimers();
    putCachedChat("c1", data("古い"));
    vi.advanceTimersByTime(MAX_AGE_MS - 10_000);
    putCachedChat("c1", data("新しい"));
    vi.advanceTimersByTime(MAX_AGE_MS - 10_000);
    // 入れ直しからは上限に達していないのでまだ生きている
    expect(getCachedChat("c1")?.conversation.title).toBe("新しい");
    vi.useRealTimers();
  });

  it("溜め込みすぎない（古い順に間引く）", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `k${i}`);
    for (const id of ids) putCachedChat(id, data(id));
    const alive = ids.filter((id) => getCachedChat(id) !== null);
    expect(alive.length).toBeLessThanOrEqual(30);
    // 残るのは新しいほう
    expect(getCachedChat("k39")).not.toBeNull();
    expect(getCachedChat("k0")).toBeNull();
    for (const id of ids) invalidateChat(id);
  });
});

/**
 * 別の端末で進んだ分は、この端末の Chat が知らないので invalidateChat が
 * 呼ばれない。60秒のあいだに開くと古い内容がそのまま出て、しかも
 * 「開いた」ことで既読になる——新しい応答を一度も見ないまま印が消える。
 *
 * サイドバーは会話の行を取り直しているので、そちらの更新時刻と
 * 突き合わせて追い越されたものは捨てる。
 */
describe("別の端末で進んだ会話", () => {
  // 控える時刻は下げられない（下げると、遅れて届いた古い値で
  // 鮮度が巻き戻る）ので、テストごとに別の会話IDを使う
  let n = 0;
  const id = () => `moved-${++n}`;

  const snapshot = (key: string, title: string, updatedAt: number) =>
    ({
      conversation: { id: key, title, updated_at: updatedAt },
      messages: [],
    }) as unknown as ChatData;

  it("一覧のほうが新しければ、取ってあるものを捨てる", () => {
    const k = id();
    putCachedChat(k, snapshot(k, "古い", 1_000));
    noteConversations([{ id: k, updated_at: 2_000 }]);
    expect(getCachedChat(k)).toBeNull();
  });

  it("同じ時刻なら、そのまま使う", () => {
    const k = id();
    putCachedChat(k, snapshot(k, "そのまま", 1_000));
    noteConversations([{ id: k, updated_at: 1_000 }]);
    expect(getCachedChat(k)?.conversation.title).toBe("そのまま");
  });

  it("一覧のほうが古ければ、そのまま使う（自分の更新が先）", () => {
    const k = id();
    putCachedChat(k, snapshot(k, "新しい", 3_000));
    noteConversations([{ id: k, updated_at: 2_000 }]);
    expect(getCachedChat(k)?.conversation.title).toBe("新しい");
  });

  it("一覧を見ていない会話は、そのまま使う", () => {
    const k = id();
    putCachedChat(k, snapshot(k, "未確認", 1_000));
    expect(getCachedChat(k)?.conversation.title).toBe("未確認");
  });

  it("控える時刻は、進んだときだけ更新する", () => {
    const k = id();
    noteConversations([{ id: k, updated_at: 5_000 }]);
    // あとから古い値が来ても引き下げない（取得の順序は保証されない）
    noteConversations([{ id: k, updated_at: 1_000 }]);
    putCachedChat(k, snapshot(k, "古い", 2_000));
    expect(getCachedChat(k)).toBeNull();
  });
});

/**
 * 先読みの順番待ち。
 *
 * ドロワーを開くと20行ほどが一度に画面に入る。以前はそれぞれが会話を
 * 丸ごと引く要求を同時に投げ、押した会話の読み込みがその後ろに並んだ。
 * 返事を止めておける fetch で、同時に何本出ているかを数える。
 */
describe("先読みの順番待ち", () => {
  let started: string[];
  let open: Map<string, (ok: boolean) => void>;
  let maxOpen: number;
  const realFetch = globalThis.fetch;

  const snapshotOf = (id: string, updatedAt = 1_000) =>
    ({
      conversation: { id, title: id, updated_at: updatedAt },
      messages: [],
    }) as unknown as ChatData;

  beforeEach(() => {
    resetChatCache();
    started = [];
    open = new Map();
    maxOpen = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const id = String(input).split("/")[3];
      started.push(id);
      return new Promise<Response>((resolve) => {
        open.set(id, (ok) => {
          open.delete(id);
          resolve(
            new Response(JSON.stringify(snapshotOf(id)), {
              status: ok ? 200 : 500,
              headers: { "Content-Type": "application/json" },
            }),
          );
        });
        maxOpen = Math.max(maxOpen, open.size);
      });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetChatCache();
  });

  /** 1本の返事を返して、続きが投げられるところまで流す。 */
  async function finish(id: string, ok = true) {
    open.get(id)!(ok);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  }

  it(`同時には ${PREFETCH_CONCURRENCY} 本までしか投げず、返るたびに次を投げる`, async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `q${i}`);
    for (const id of ids) prefetchChat(id);
    expect(started).toEqual(ids.slice(0, PREFETCH_CONCURRENCY));

    // 返るたびに1本ずつ、並んだ順に
    await finish("q0");
    expect(started).toEqual(ids.slice(0, PREFETCH_CONCURRENCY + 1));
    for (const id of ids.slice(1)) {
      if (open.has(id)) await finish(id);
      // 並んでいたものが後から投げられていれば、それも返す
      for (const s of [...open.keys()]) await finish(s);
    }
    expect(started).toEqual(ids);
    expect(maxOpen).toBe(PREFETCH_CONCURRENCY);
    for (const id of ids) expect(getCachedChat(id)).not.toBeNull();
  });

  it("指が乗った会話は、並んでいる先読みより先に取る", async () => {
    for (const id of ["a", "b", "c", "d", "e"]) prefetchChat(id);
    prefetchChat("e", { intent: true });
    await finish("a");
    // c・d を飛ばして e
    expect(started[PREFETCH_CONCURRENCY]).toBe("e");
  });

  it("画面から出た行の、まだ投げていない先読みは取り下げる", async () => {
    for (const id of ["a", "b", "c", "d"]) prefetchChat(id);
    cancelPrefetch("c");
    await finish("a");
    await finish("b");
    await finish("d");
    expect(started).toEqual(["a", "b", "d"]);
  });

  it("並べられる数には上限がある（押し出されて捨てるだけの分は並べない）", async () => {
    for (let i = 0; i < 200; i++) prefetchChat(`m${i}`);
    expect(started.length).toBe(PREFETCH_CONCURRENCY);
    // 全部返し切るまで流す
    while (open.size > 0) await finish([...open.keys()][0]);
    // 写しは30件しか持てないので、それを超えて取りに行っても捨てるだけ
    expect(started.length).toBeLessThanOrEqual(PREFETCH_CONCURRENCY + 30);
    expect(started.length).toBeGreaterThan(PREFETCH_CONCURRENCY);
    // 残すのは先に見えたほう
    expect(started.slice(0, 5)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("取りに行っている最中の会話は、同じ要求を待てる", async () => {
    prefetchChat("p");
    const pending = pendingChat("p");
    expect(pending).not.toBeNull();
    await finish("p");
    expect((await pending)?.conversation.id).toBe("p");
    // 終われば居ない
    expect(pendingChat("p")).toBeNull();
  });

  it("失敗した先読みは写しを置かず、待っていた側には null を返す", async () => {
    prefetchChat("x");
    const pending = pendingChat("x");
    await finish("x", false);
    expect(await pending).toBeNull();
    expect(getCachedChat("x")).toBeNull();
  });

  it("新しい写しがあれば取りに行かず、一覧に追い越されていれば取り直す", async () => {
    putCachedChat("f", snapshotOf("f", 1_000));
    prefetchChat("f", { intent: true });
    expect(started).toEqual([]);

    // 別の端末で進んだ（一覧の更新時刻が写しより新しい）
    noteConversations([{ id: "f", updated_at: 2_000 }]);
    prefetchChat("f", { intent: true });
    expect(started).toEqual(["f"]);
  });
});
