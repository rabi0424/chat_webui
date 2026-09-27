import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 実行体（GenerationRunner）がジョブを受けてから上流へ投げるまで。
 *
 * 送信から上流へ投げるまでの待ちに、実行体の側で足されていたものが2つ:
 *   - アラームを +50ms に置いていた（待つ理由が無い）
 *   - 行の状態を確かめる往復（D1）が済んでから、添付の読み出し（D1＋R2）を
 *     始めていた
 * 確認そのものは省けない（行が消えた・止められた・前の実行が失われた
 * ときに上流へ投げてしまうと、取り消せない課金になる）。重ねるだけにする。
 */

const box = vi.hoisted(() => ({
  row: null as null | { status: string; content: string },
  order: [] as string[],
  expandedResult: null as unknown,
  expandPromises: [] as Promise<unknown>[],
  expandFails: false,
  singleCalls: [] as unknown[][],
  finalized: [] as unknown[],
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, e: unknown) {
      this.ctx = ctx;
      this.env = e;
    }
  },
}));

vi.mock("../../app/lib/db.server", () => ({
  getMessage: async () => {
    box.order.push("getMessage:start");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    box.order.push("getMessage:end");
    return box.row;
  },
  finalizeGeneration: async (_id: string, p: unknown) => {
    box.finalized.push(p);
    return true;
  },
}));

vi.mock("../../app/lib/generation.server", () => ({
  expandAttachmentsFor: () => {
    box.order.push("expand");
    const p = box.expandFails
      ? Promise.reject(new Error("R2 が落ちている"))
      : Promise.resolve(box.expandedResult);
    box.expandPromises.push(p);
    return p;
  },
  runSingleGeneration: async (...args: unknown[]) => {
    box.order.push("single");
    box.singleCalls.push(args);
  },
}));

vi.mock("../../app/lib/retry-run.server", () => ({
  runAttemptJob: async () => {},
  runRetryGenerationJob: async () => ({ done: true }),
}));

const { GenerationRunner } = await import("../../workers/app");

/** DO のストレージの代わり（Map と、置かれたアラームの時刻）。 */
function makeCtx() {
  const data = new Map<string, unknown>();
  const alarms: number[] = [];
  const storage = {
    async get(key: string | string[]) {
      if (Array.isArray(key)) {
        return new Map(key.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
      }
      return data.get(key);
    },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === "string") data.set(key, value);
      else for (const [k, v] of Object.entries(key)) data.set(k, v);
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) data.delete(k);
    },
    async deleteAll() {
      data.clear();
    },
    async setAlarm(at: number) {
      alarms.push(at);
    },
  };
  return { ctx: { storage }, alarms };
}

const job = (extra: Record<string, unknown> = {}) => ({
  conversationId: "c1",
  assistantMessageId: "a1",
  model: "vendor/m",
  web: false,
  webTools: false,
  imageOutput: false,
  paramsState: null,
  messages: [{ role: "user", content: "やあ", attachmentIds: ["img"] }],
  ...extra,
});

async function start(body: Record<string, unknown>) {
  const { ctx, alarms } = makeCtx();
  const runner = new GenerationRunner(ctx as never, {} as never);
  const res = await runner.fetch(
    new Request("https://generator/start", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return { runner, res, alarms };
}

beforeEach(() => {
  box.row = { status: "streaming", content: "" };
  box.order = [];
  box.expandedResult = [{ role: "user", content: "展開済み" }];
  box.expandPromises = [];
  box.expandFails = false;
  box.singleCalls = [];
  box.finalized = [];
});

describe("ジョブを受けてから上流へ投げるまで", () => {
  it("アラームは先へ延ばさず、いまに置く", async () => {
    const before = Date.now();
    const { res, alarms } = await start(job());
    const after = Date.now();
    expect(res.status).toBe(202);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toBeGreaterThanOrEqual(before);
    expect(alarms[0]).toBeLessThanOrEqual(after);
  });

  it("行の確認を待つあいだに添付を読み始め、読んだものをそのまま渡す", async () => {
    const { runner } = await start(job());
    await runner.alarm();
    // 確認が返る前に読み始めている
    expect(box.order.indexOf("expand")).toBeLessThan(
      box.order.indexOf("getMessage:end"),
    );
    expect(box.singleCalls).toHaveLength(1);
    // 読み始めたその1回を渡す（渡し損ねると、生成の側でもう一度読み直す）
    expect(box.expandPromises).toHaveLength(1);
    expect(box.singleCalls[0][2]).toBe(box.expandPromises[0]);
  });

  it("行が生成中でなければ、読み始めていても上流へは投げない", async () => {
    box.row = { status: "done", content: "止められた" };
    box.expandFails = true; // 使わなかった読み出しの失敗は外へ漏らさない
    const { runner } = await start(job());
    await runner.alarm();
    expect(box.order).toContain("expand");
    expect(box.singleCalls).toHaveLength(0);
    // 失敗の確定もしない（止められた行はそのまま）
    expect(box.finalized).toHaveLength(0);
  });

  it("前の実行が失われた後の再送なら、確定させて投げない（二重課金を避ける）", async () => {
    box.row = { status: "streaming", content: "途中まで" };
    const { runner } = await start(job());
    await runner.alarm();
    expect(box.singleCalls).toHaveLength(0);
    expect(box.finalized).toHaveLength(1);
  });

  it("「成功するまで生成」の司令役は添付を読まない（担当が自分で読む）", async () => {
    const { runner } = await start(
      job({ imageOutput: true, retry: { mode: "count", target: 1 } }),
    );
    await runner.alarm();
    expect(box.order).not.toContain("expand");
  });
});
