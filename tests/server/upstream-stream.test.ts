import { describe, expect, it } from "vitest";

/**
 * 上流のストリームを読む見張り。
 *
 * 無音の見張り（1バイトも来ない時間）だけでは、OpenRouter のように
 * プロバイダを待つあいだ「処理中」のコメント行を送り続ける上流を
 * 切れない。コメントが届くたびに時計が戻り、プロバイダ側が固まって
 * いると永久に待つ——実際に「上流で待ち」のまま進まず、停止しても
 * その本を待ち続けて終われなかった。外からの signal で切れることを、
 * 実際にコメント行を流し続けるストリームで見る。
 */
const { readUpstreamStream } = await import("../../app/lib/generation.server");

const encoder = new TextEncoder();

/** 一定間隔で行を流し続けるストリーム。閉じるまで終わらない。 */
function ticking(line: string, everyMs: number): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => controller.enqueue(encoder.encode(line)), everyMs);
    },
    cancel() {
      clearInterval(timer);
    },
  });
}

/** 何も送らないストリーム。 */
function silent(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {} });
}

describe("readUpstreamStream", () => {
  it("コメント行が届き続けるあいだは無音の見張りが切れず、signal で切れる", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort("締め切り"), 150);
    const started = Date.now();
    const result = await readUpstreamStream(
      ticking(": OPENROUTER PROCESSING\n", 20),
      undefined,
      { idleTimeoutMs: 60, signal: controller.signal },
    );
    const took = Date.now() - started;
    // 無音の見張り（60ms）では切れていない。切ったのは signal（150ms）
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(1_000);
    expect(result.interrupted).toBe("締め切り");
    expect(result.content).toBe("");
  });

  it("読んでいる最中でも切れる（次の行を待ってからではない）", async () => {
    // 行は300msごと。100msで切ったとき、読み始めの確認だけでは次の行が
    // 届く300msまで待ってしまう。待っている read() 自体を起こすこと
    const controller = new AbortController();
    setTimeout(() => controller.abort("締め切り"), 100);
    const started = Date.now();
    const result = await readUpstreamStream(
      ticking(": OPENROUTER PROCESSING\n", 300),
      undefined,
      { idleTimeoutMs: 1_000, signal: controller.signal },
    );
    expect(Date.now() - started).toBeLessThan(250);
    expect(result.interrupted).toBe("締め切り");
  });

  it("黙り込んだ上流は無音の見張りで切る", async () => {
    const result = await readUpstreamStream(silent(), undefined, {
      idleTimeoutMs: 50,
      signal: new AbortController().signal,
    });
    expect(result.interrupted).toBe("上流からの応答が途絶えました");
  });

  it("既に切られた signal では読み始めない", async () => {
    const controller = new AbortController();
    controller.abort("停止により打ち切りました");
    const result = await readUpstreamStream(silent(), undefined, {
      idleTimeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(result.interrupted).toBe("停止により打ち切りました");
  });

  it("普通に終わるストリームには何も影響しない", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"こんにちは"}}]}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });
    const result = await readUpstreamStream(body, undefined, {
      idleTimeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(result.content).toBe("こんにちは");
    expect(result.interrupted).toBeUndefined();
  });
});

describe("本文の中で届くエラー", () => {
  it("200 のあとに error を含むチャンクが来たら拾う（空の応答に見せない）", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            ': OPENROUTER PROCESSING\n\n' +
              'data: {"id":"x","error":{"message":"Your request was rejected by the safety system.","code":400,"metadata":{"provider_name":"OpenAI","raw":"{\\"error\\":{\\"code\\":\\"moderation_blocked\\"}}"}},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
        controller.close();
      },
    });
    const result = await readUpstreamStream(body, undefined, {
      idleTimeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(result.content).toBe("");
    expect(result.error?.code).toBe(400);
    expect(result.error?.detail).toContain("safety system");
    expect(result.error?.raw).toContain("moderation_blocked");
    expect(result.error?.raw).toContain("OpenAI");
  });
});
