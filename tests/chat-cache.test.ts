import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCachedChat,
  invalidateChat,
  noteConversations,
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
