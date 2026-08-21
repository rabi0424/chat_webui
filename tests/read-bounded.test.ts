import { describe, expect, it } from "vitest";
import { readBounded } from "../app/lib/read-bounded";

/**
 * 取り込む画像の大きさの上限。
 *
 * arrayBuffer() は本文を最後まで受け取ってから返すので、そのあとで
 * 大きさを見ても遅い——上限を超えていると分かるころには、超えたぶんを
 * すべてメモリに載せている。長さを申告しない上流もあるので、読みながら
 * 数えて、超えたらそこで打ち切る。
 */

/** 指定した塊で本文を流す応答。読まれた塊の数を数えておく。 */
function streaming(chunks: number[]) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunks[sent++]).fill(1));
    },
  });
  return {
    response: new Response(body),
    read: () => sent,
  };
}

describe("上限までしか読まない", () => {
  it("収まっていれば、そのまま返す", async () => {
    const { response } = streaming([10, 20, 30]);
    const buf = await readBounded(response, 1000);
    expect(buf?.byteLength).toBe(60);
  });

  it("ちょうど上限なら通す", async () => {
    const { response } = streaming([50, 50]);
    expect((await readBounded(response, 100))?.byteLength).toBe(100);
  });

  it("超えたら捨てる", async () => {
    const { response } = streaming([50, 50, 50]);
    expect(await readBounded(response, 100)).toBeNull();
  });

  /** これが本題。超えたと分かった時点で読むのをやめる。 */
  it("超えたら、そこから先は読まない", async () => {
    const { response, read } = streaming([60, 60, 60, 60, 60]);
    expect(await readBounded(response, 100)).toBeNull();
    // 2つ読んだ時点で 120 > 100。残り3つは読まない
    expect(read()).toBe(2);
  });

  it("本文が無ければ null", async () => {
    expect(await readBounded(new Response(null), 100)).toBeNull();
  });

  it("空の本文は 0 バイトとして返す", async () => {
    const { response } = streaming([]);
    expect((await readBounded(response, 100))?.byteLength).toBe(0);
  });

  it("途中で切れたら捨てる", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.error(new Error("切れました"));
      },
    });
    expect(await readBounded(new Response(body), 100)).toBeNull();
  });

  it("塊をつなげた中身が正しい", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      },
    });
    const buf = await readBounded(new Response(body), 100);
    expect([...new Uint8Array(buf!)]).toEqual([1, 2, 3, 4, 5]);
  });
});
