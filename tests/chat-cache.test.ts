import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCachedChat,
  invalidateChat,
  putCachedChat,
  type ChatData,
} from "../app/lib/chat-cache";

/**
 * 会話の先読みキャッシュ。
 *
 * 古い内容を掴んだまま返すと、生成が進んだ会話を開いても止まって
 * 見えたり、変更した設定が巻き戻って見えたりする。「いつ捨てるか」を
 * 押さえる。
 */
const data = (title: string) =>
  ({ conversation: { id: "c1", title }, messages: [] }) as unknown as ChatData;

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

  it("60秒を過ぎたら返さない", () => {
    vi.useFakeTimers();
    putCachedChat("c1", data("x"));
    vi.advanceTimersByTime(59_000);
    expect(getCachedChat("c1")).not.toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(getCachedChat("c1")).toBeNull();
    vi.useRealTimers();
  });

  it("入れ直すと時計も鮮度も新しくなる", () => {
    vi.useFakeTimers();
    putCachedChat("c1", data("古い"));
    vi.advanceTimersByTime(50_000);
    putCachedChat("c1", data("新しい"));
    vi.advanceTimersByTime(50_000);
    // 入れ直しから50秒なのでまだ生きている
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
