import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushInterval } from "../../app/lib/flush-cadence";

/**
 * 単発生成の途中経過をいつ書くか・確定をいつ書くか。
 *
 * どれも「時刻」の話で、ソースを読んでも追いにくい。上流の本文を手で
 * 1チャンクずつ流し、偽の時計を進めながら D1 への書き込みを数える。
 *
 * 1. 最初のトークンは待たずに書く（以前はストリームを開いてから
 *    0.5 秒経つまで書かなかった）
 * 2. 上流が黙っても、受け取った分は間隔が明けたところで書く（以前は
 *    次のチャンクか、15秒ごとの生存確認まで出なかった）
 * 3. それでも書く回数の総数は以前と変わらない（サブリクエストの枠）
 * 4. Poe はポイントの照会を待たずに確定し、分かったら後から足す
 */
vi.mock("cloudflare:workers", () => ({
  env: { OPENROUTER_API_KEY: "test-key", POE_API_KEY: "test-key" },
  DurableObject: class {},
}));

const db = vi.hoisted(() => ({
  /** flushGeneration の呼び出し（時刻と本文）。 */
  flushes: [] as { at: number; content: string }[],
  /** 起きたことの順番。 */
  events: [] as string[],
  finalized: null as null | { status: string; content: string; usageJson: string | null },
  finalizeApplies: true,
  reconciled: [] as Record<string, unknown>[],
}));

vi.mock("../../app/lib/db.server", () => ({
  flushGeneration: async (_id: string, partial: { content: string }) => {
    db.flushes.push({ at: Date.now(), content: partial.content });
    return { stopRequested: false, applied: true };
  },
  finalizeGeneration: async (
    _id: string,
    result: { status: string; content: string; usageJson: string | null },
  ) => {
    db.events.push("finalize");
    db.finalized = result;
    return db.finalizeApplies;
  },
  reconcileMessageUsage: async (params: Record<string, unknown>) => {
    db.events.push("reconcile");
    db.reconciled.push(params);
  },
  getAttachments: async () => [],
  createGeneratedAttachment: async () => "att",
  recordStandaloneUsage: async () => {},
}));

const poe = vi.hoisted(() => ({
  /** 照会ごとに返す答え。尽きたら null。 */
  answers: [] as ({ points: number; costUsd?: number } | null)[],
  /** 照会が呼ばれた時刻。 */
  calls: [] as number[],
  /** 答えを返すまで止めておく。 */
  gate: null as null | Promise<void>,
}));

vi.mock("../../app/lib/openrouter.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPoeRecentPoints: async () => {
    poe.calls.push(Date.now());
    db.events.push("points-lookup");
    if (poe.gate) await poe.gate;
    return poe.answers.shift() ?? null;
  },
}));

const { runSingleGeneration } = await import("../../app/lib/generation.server");

const encoder = new TextEncoder();
/** 手で流す上流。push で1チャンク、close で終わり。 */
let upstream: {
  push: (text: string) => void;
  /** 本文を伸ばさない行（OpenRouter が待たせるあいだ送る「処理中」）。 */
  comment: () => void;
  close: () => void;
};

function stubUpstream(): void {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  upstream = {
    push: (text) =>
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
        ),
      ),
    comment: () => controller.enqueue(encoder.encode(": OPENROUTER PROCESSING\n\n")),
    close: () => {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  };
  vi.stubGlobal("fetch", async () =>
    new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
}

const textJob = {
  conversationId: "c1",
  assistantMessageId: "m1",
  model: "vendor/text-model",
  web: false,
  paramsState: null,
  messages: [{ role: "user" as const, content: "hi" }],
};
const poeJob = { ...textJob, model: "poe:test-bot" };

/** 生存確認は本番と同じ15秒。締め切りは長い流しを切らない長さに。 */
const CLOCK = { heartbeatMs: 15_000, deadlineMs: 60 * 60_000 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  db.flushes = [];
  db.events = [];
  db.finalized = null;
  db.finalizeApplies = true;
  db.reconciled = [];
  poe.answers = [];
  poe.calls = [];
  poe.gate = null;
  stubUpstream();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 上流へ投げてストリームを開くところまで進める。開いた時刻を返す。 */
async function open(job = textJob): Promise<{ run: Promise<void>; openedAt: number }> {
  const run = runSingleGeneration(job, CLOCK);
  await vi.advanceTimersByTimeAsync(0);
  return { run, openedAt: Date.now() };
}

describe("途中経過を書く時刻", () => {
  it("最初のトークンは待たずに書く", async () => {
    const { run } = await open();
    // ストリームを開いてすぐ最初のトークンが届く（開いた時刻から
    // 数えていたときは、0.5 秒経つまで書かなかった）
    await vi.advanceTimersByTimeAsync(50);
    const at = Date.now();
    upstream.push("あ");
    await vi.advanceTimersByTimeAsync(0);
    expect(db.flushes).toEqual([{ at, content: "あ" }]);

    upstream.close();
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(db.finalized).toMatchObject({ status: "done", content: "あ" });
  });

  it("上流が黙っても、受け取った分は間隔が明けたところで書く", async () => {
    const { run } = await open();
    upstream.push("a");
    await vi.advanceTimersByTimeAsync(0);
    const first = Date.now();
    expect(db.flushes.map((f) => f.content)).toEqual(["a"]);

    // 間隔の内側に届いた分は、すぐには書かない（回数を守るため）
    await vi.advanceTimersByTimeAsync(100);
    upstream.push("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(db.flushes).toHaveLength(1);

    // ここから上流は黙る（Web検索・ツール待ち）。次のチャンクが来なく
    // ても、間隔が明けた時点で書き残しを書く
    await vi.advanceTimersByTimeAsync(first + flushInterval(1) - Date.now() - 1);
    expect(db.flushes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.flushes).toEqual([
      { at: first, content: "a" },
      { at: first + flushInterval(1), content: "ab" },
    ]);

    // 書き残しが無ければ、黙っているあいだ書き直さない。「処理中」の
    // 行が届き続けても、本文が伸びていないなら書かない
    for (let i = 0; i < 10; i++) {
      upstream.comment();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(db.flushes).toHaveLength(2);

    upstream.close();
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(db.finalized).toMatchObject({ status: "done", content: "ab" });
  });

  it("長く流れ続けても、書く回数は以前の作りと1回しか違わない", async () => {
    /*
     * 以前の作り: ストリームを開いた時刻から数え、チャンクが届いたときに
     * 前回から flushInterval(回数) 経っていれば書く。この回数の上限が
     * サブリクエストの枠に収まることは flush-cadence.test.ts が見ている。
     * 同じ到着の並びをここで数え、新しい作りと比べる。
     */
    const STEP = 100;
    const DURATION = 13 * 60_000; // 単発生成の締め切りいっぱい
    let old = 0;
    let lastProgress = 0;
    for (let t = STEP; t <= DURATION; t += STEP) {
      if (t - lastProgress >= flushInterval(old)) {
        lastProgress = t;
        old++;
      }
    }

    const { run, openedAt } = await open();
    for (let t = STEP; t <= DURATION; t += STEP) {
      await vi.advanceTimersByTimeAsync(STEP);
      upstream.push("x");
    }
    await vi.advanceTimersByTimeAsync(0);
    const during = db.flushes.filter((f) => f.at >= openedAt).length;
    upstream.close();
    await vi.advanceTimersByTimeAsync(0);
    await run;

    // 増えてよいのは「最初のトークンを待たずに書く」1回だけ
    expect(during).toBeLessThanOrEqual(old + 1);
    // 書かなくなったのでもない（回数が減りすぎると画面が止まって見える）
    expect(during).toBeGreaterThanOrEqual(old);
    expect(db.finalized?.content).toHaveLength(DURATION / STEP);
  }, 60_000);
});

describe("Poe の確定とポイント", () => {
  it("ポイントの照会を待たずに完了を書き、分かったら後から足す", async () => {
    let release!: () => void;
    poe.gate = new Promise<void>((r) => {
      release = r;
    });
    poe.answers = [{ points: 42, costUsd: 0.01 }];

    const { run } = await open(poeJob);
    upstream.push("こんにちは");
    upstream.close();
    await vi.advanceTimersByTimeAsync(0);

    // ストリームが終わった時点で、もう完了している。最後の数文字も
    // ここで書かれている（以前は照会を待つ 1.3〜4 秒のあいだ書かれ
    // なかった）
    expect(db.finalized).toMatchObject({ status: "done", content: "こんにちは" });
    expect(poe.calls).toHaveLength(0);

    // 履歴への反映を待ってから照会する（照会はまだ返らない）
    await vi.advanceTimersByTimeAsync(1_200);
    expect(poe.calls).toHaveLength(1);
    expect(db.reconciled).toHaveLength(0);

    release();
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(db.events).toEqual(["finalize", "points-lookup", "reconcile"]);
    expect(db.reconciled[0]).toMatchObject({
      messageId: "m1",
      conversationId: "c1",
      modelId: "poe:test-bot",
      points: 42,
      cost: 0.01,
    });
    expect(JSON.parse(db.reconciled[0].usageJson as string)).toMatchObject({
      points: 42,
      cost: 0.01,
    });
  });

  it("1回目で見つからなければ、もう一度だけ照会する", async () => {
    poe.answers = [null, { points: 7 }];
    const { run } = await open(poeJob);
    upstream.push("x");
    upstream.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(poe.calls).toHaveLength(2);
    expect(db.reconciled).toHaveLength(1);
    expect(db.reconciled[0]).toMatchObject({ points: 7, cost: null });
  });

  it("見つからなければ、確定したときのまま何も書き足さない", async () => {
    const { run } = await open(poeJob);
    upstream.push("x");
    upstream.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(db.finalized?.status).toBe("done");
    expect(poe.calls).toHaveLength(2);
    expect(db.reconciled).toHaveLength(0);
  });

  it("確定が当たらなかった（別の経路が先に確定させた）なら照会しない", async () => {
    // 行が既に中断として確定済みなら、台帳もそちらの扱い。こちらが
    // 後から台帳へ積むと、行と台帳が食い違う
    db.finalizeApplies = false;
    const { run } = await open(poeJob);
    upstream.push("x");
    upstream.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(db.finalized).not.toBeNull();
    expect(poe.calls).toHaveLength(0);
  });

  it("Poe 以外は照会しない", async () => {
    const { run } = await open();
    upstream.push("x");
    upstream.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(db.finalized?.status).toBe("done");
    expect(poe.calls).toHaveLength(0);
  });
});
