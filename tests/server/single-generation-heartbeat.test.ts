import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 単発生成の生存確認（heartbeat）と停止（監査 S-1・S-2・S-5）。
 *
 * 生存確認は**上流へ投げる前**から打ち始めなければならない。ヘッダが
 * 返ってから打ち始める作りだと、画像のモデル（ヘッダまで何分もかかる）
 * では flushed_at が更新されず、60秒で行が中断として確定する——画像は
 * 出来上がるのに本文に付かず、台帳にも載らない。
 *
 * 同じ経路で停止要求も拾う。上流が黙っているあいだ停止が「次のチャンク
 * まで」効かなかったのは、打ち直しの返り値を捨てていたため。
 *
 * ソースを読んでも「いつから打つか」は追いにくい。黙ったままの上流を
 * 実際に立てて、ヘッダを待っているあいだに印が打たれること・停止が
 * その場で効くこと・締め切りで打ち切られることを見る。
 */
vi.mock("cloudflare:workers", () => ({
  env: { OPENROUTER_API_KEY: "test-key" },
  DurableObject: class {},
}));

const db = vi.hoisted(() => ({
  /** flushGeneration が呼ばれた時刻。 */
  flushes: [] as number[],
  /** 何回目の打ち直しで停止要求を返すか（0 で返さない）。 */
  stopAt: 0,
  finalized: null as null | { status: string; content: string; error?: string | null },
}));

vi.mock("../../app/lib/db.server", () => ({
  flushGeneration: async () => {
    db.flushes.push(Date.now());
    return {
      stopRequested: db.stopAt > 0 && db.flushes.length >= db.stopAt,
      applied: true,
    };
  },
  finalizeGeneration: async (
    _id: string,
    result: { status: string; content: string; error?: string | null },
  ) => {
    db.finalized = result;
    return true;
  },
  getAttachments: async () => [],
  createGeneratedAttachment: async () => "att",
  recordStandaloneUsage: async () => {},
}));

const { runSingleGeneration } = await import("../../app/lib/generation.server");

let server: http.Server;
let origin = "";
const realFetch = globalThis.fetch;
/** 上流がヘッダを返した時点で、打ち直しが何回済んでいたか。 */
let flushesAtHeaders = -1;
/** ヘッダを返すまでの待ち。生存確認の間隔より十分長くする。 */
const HEADER_DELAY_MS = 300;
const HEARTBEAT_MS = 40;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    // ヘッダを返さないまま黙り込む上流
    if (req.url === "/silent") return;
    // 少し待ってから、短い応答を1つ流して閉じる上流
    const timer = setTimeout(() => {
      flushesAtHeaders = db.flushes.length;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "こんにちは" } }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    }, HEADER_DELAY_MS);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  db.flushes = [];
  db.stopAt = 0;
  db.finalized = null;
  flushesAtHeaders = -1;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 上流の宛先だけを差し替える。signal はそのまま渡す。 */
function routeTo(path: string) {
  vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) =>
    realFetch(`${origin}${path}`, init),
  );
}

const job = {
  conversationId: "c1",
  assistantMessageId: "m1",
  model: "vendor/text-model",
  web: false,
  paramsState: null,
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("単発生成の生存確認", () => {
  it("ヘッダを待っているあいだも印を打つ（S-1）", async () => {
    routeTo("/slow");
    await runSingleGeneration(job, {
      heartbeatMs: HEARTBEAT_MS,
      deadlineMs: 10_000,
    });
    // ヘッダが返る前に少なくとも数回は打っている
    expect(flushesAtHeaders).toBeGreaterThanOrEqual(3);
    expect(db.finalized).toMatchObject({ status: "done", content: "こんにちは" });
  });

  it("上流が黙っているあいだの停止要求で、その場で切って確定する（S-2）", async () => {
    routeTo("/silent");
    db.stopAt = 2;
    const started = Date.now();
    await runSingleGeneration(job, {
      heartbeatMs: HEARTBEAT_MS,
      deadlineMs: 10_000,
    });
    // 締め切り（10秒）でもヘッダの猶予（60秒）でもなく、停止で終わっている
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(db.finalized).toMatchObject({
      status: "error",
      error: "生成開始直後に停止されました",
    });
  });

  it("総時間の締め切りで打ち切り、その旨を残して確定する（S-5）", async () => {
    routeTo("/silent");
    await runSingleGeneration(job, {
      heartbeatMs: 1_000,
      deadlineMs: 200,
    });
    expect(db.finalized?.status).toBe("error");
    expect(db.finalized?.error).toContain("打ち切りました");
  });
});
