import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 司令役（`runRetryGenerationJob`）を実際に回す。
 *
 * ここまで配線テスト（ソースに特定の文字列があるか）だけで見張っていたが、
 * 本番で2度、司令役が黙って終わった。文字列は合っているのに動きが違う、
 * という壊れ方は文字列では捕まらない。D1・上流・別の実行を差し替えて、
 * **本当に担当を起こし続けるか**を見る。
 *
 * 差し替えるのは境界だけ（db.server / limit.server / 別の実行の呼び出し）。
 * 司令役の中の判断（枠・数え上げ・終わりの判定）は本物を通す。
 */
/** 起こした担当ごとの、引き受けた依頼の id。 */
const spawned: string[][] = [];
/** 起こした担当へ渡した仕事（同時数の上書きが届いているか）。 */
const spawnedJobs: { attemptIds: string[]; workerConcurrency?: number }[] = [];
const inserted: { id: string; seq: number }[] = [];
const failed: string[] = [];
/** 担当が書いた結果。 */
const finished: {
  id: string;
  kind: string;
  detail: string | null;
  doMs?: number | null;
}[] = [];
/** tickRetryRun が返す値。テストごとに差し替える。 */
let tickResult: {
  stopRequested: boolean;
  applied: boolean;
  finished: {
    id: string;
    kind: "success" | "refused" | "transient" | "fatal";
    detail: string | null;
    wait_ms: number | null;
    message_id: string | null;
  }[];
  running: number;
};
let tickCalls: string[] = [];
let finalized: { status: string; content: string; error?: string | null } | null =
  null;
/** 何回目の往復で何を返すか。 */
let onTick: ((n: number) => void) | null = null;
/** 決着した依頼の本数と、かかった時間の合計。 */
let durations = { count: 0, totalMs: 0 };
/** その日に使った「実行体が起きている時間」（ミリ秒）。 */
let dailyDoMs = 0;
/** その集計を何回読んだか（設定が0のときは読まないこと）。 */
let dailyChecks = 0;
/** 司令役が自分の起きていた時間として書き足したぶん。 */
const coordinatorMs: number[] = [];
/** 要約に出す、司令役の起きていた時間の合計。 */
let coordinatorTotalMs = 0;
/** 古い記録の掃除を何回頼んだか。 */
let pruned = 0;
/** 応答ヘッダが返るまでの時間（同時に投げられているかの物差し）。 */
let headerTimes = { count: 0, avgMs: 0, maxMs: 0 };
/** 続きの実行の頭で D1 から取り直す値。 */
let snapshot = {
  counts: { success: 0, refused: 0, transient: 0, fatal: 0 },
  launched: 0,
  lastSeq: 0,
  firstRefusal: null as string | null,
  startedAt: null as number | null,
};

vi.mock("cloudflare:workers", () => ({
  env: {
    GENERATOR: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (_url: string, init: { body: string }) => {
          const body = JSON.parse(init.body) as {
            attemptIds: string[];
            workerConcurrency?: number;
          };
          spawnedJobs.push(body);
          spawned.push(body.attemptIds);
          return new Response("{}", { status: 202 });
        },
      }),
    },
  },
  DurableObject: class {},
}));

vi.mock("../../app/lib/db.server", () => ({
  createRetryRun: vi.fn(async () => {}),
  pruneOldRetryRun: vi.fn(async () => {
    pruned++;
    return true;
  }),
  retryRunSnapshot: vi.fn(async () => snapshot),
  tickRetryRun: vi.fn(async (_id: string, content: string) => {
    tickCalls.push(content);
    onTick?.(tickCalls.length);
    return tickResult;
  }),
  insertRetryAttempts: vi.fn(
    async (p: { attempts: { id: string; seq: number }[] }) => {
      inserted.push(...p.attempts);
    },
  ),
  failRetryAttempts: vi.fn(async (p: { ids: string[] }) => {
    failed.push(...p.ids);
  }),
  markRetryAttemptsProcessed: vi.fn(async () => {}),
  retryRunDurations: vi.fn(async () => durations),
  retryRunCoordinatorMs: vi.fn(async () => coordinatorTotalMs),
  dailyDurableMs: vi.fn(async () => {
    dailyChecks++;
    return dailyDoMs;
  }),
  noteCoordinatorMs: vi.fn(async (_id: string, ms: number) => {
    coordinatorMs.push(ms);
  }),
  retryRunHeaderTimes: vi.fn(async () => headerTimes),
  sweepLostRetryAttempts: vi.fn(async () => 0),
  finishRetryAttempt: vi.fn(
    async (p: {
      id: string;
      kind: string;
      detail: string | null;
      doMs?: number | null;
    }) => {
      finished.push(p);
      return true;
    },
  ),
  appendRetrySuccess: vi.fn(async () => "m1"),
  rewriteMessageContent: vi.fn(async () => {}),
  finalizeGeneration: vi.fn(
    async (_id: string, r: { status: string; content: string; error?: string | null }) => {
      finalized = r;
      return true;
    },
  ),
}));

const monthlyLimit = vi.fn(
  async (_now?: number, _provisional?: unknown) => ({ blocked: false }),
);
vi.mock("../../app/lib/limit.server", () => ({
  checkMonthlyLimit: monthlyLimit,
}));

/** 1本の上流呼び出し。同時に何本走ったかを数える。 */
const attemptCalls = { started: 0, finished: 0, peak: 0 };
/** 担当が使ってよい通信の数。尽きたら新しく投げない。 */
let launchAllowance = Number.POSITIVE_INFINITY;
const upstream = vi.fn(async (_job: unknown, _messages: unknown, spend?: () => void) => {
  spend?.();
  attemptCalls.started++;
  attemptCalls.peak = Math.max(
    attemptCalls.peak,
    attemptCalls.started - attemptCalls.finished,
  );
  // 起こす間隔（200ms）より長くする。短いと1本ずつ終わってしまい、
  // 同時に走っていることを検査できない
  await new Promise((r) => setTimeout(r, 1_500));
  attemptCalls.finished++;
  return { kind: "refused" as const, text: "だめです", usageJson: null };
});

vi.mock("../../app/lib/generation.server", () => ({
  runAttempt: upstream,
  expandAttachments: vi.fn(async (m: unknown) => m),
  promptOf: vi.fn(() => null),
  createBudget: vi.fn(() => {
    let spent = 0;
    return {
      spend: () => {
        spent++;
      },
      canLaunch: () => spent < launchAllowance,
    };
  }),
  createRateLimitGate: vi.fn(() => ({})),
  captureGeneratedImages: vi.fn(),
  recordRefusalUsage: vi.fn(),
}));

const poePoints = vi.fn(async (): Promise<{ points: number; costUsd?: number } | null> => null);
vi.mock("../../app/lib/openrouter.server", () => ({
  POE_PREFIX: "poe:",
  fetchPoeRunPoints: poePoints,
}));

const { runAttemptJob, runRetryGenerationJob } = await import(
  "../../app/lib/retry-run.server"
);
const { parseRetryProgress } = await import("../../app/lib/retry");

const job = {
  conversationId: "c1",
  assistantMessageId: "s1",
  model: "poe:Imagen",
  web: false,
  imageOutput: true,
  paramsState: null,
  messages: [],
} as never;

const retry = { target: 2, maxAttempts: 50, concurrency: 4, smartPercent: null };

const idle = {
  stopRequested: false,
  applied: true,
  finished: [] as never[],
  running: 0,
};

beforeEach(() => {
  spawned.length = 0;
  spawnedJobs.length = 0;
  inserted.length = 0;
  failed.length = 0;
  finished.length = 0;
  attemptCalls.started = 0;
  attemptCalls.finished = 0;
  attemptCalls.peak = 0;
  upstream.mockClear();
  launchAllowance = Number.POSITIVE_INFINITY;
  tickCalls = [];
  finalized = null;
  onTick = null;
  tickResult = { ...idle };
  poePoints.mockClear();
  poePoints.mockResolvedValue(null);
  monthlyLimit.mockClear();
  durations = { count: 0, totalMs: 0, doMs: 0 };
  headerTimes = { count: 0, avgMs: 0, maxMs: 0 };
  dailyDoMs = 0;
  dailyChecks = 0;
  coordinatorMs.length = 0;
  coordinatorTotalMs = 0;
  pruned = 0;
  snapshot = {
    counts: { success: 0, refused: 0, transient: 0, fatal: 0 },
    launched: 0,
    lastSeq: 0,
    firstRefusal: null,
    startedAt: null,
  };
});

describe("司令役を回す", () => {
  it(
    "実行のたびに、古い記録を片付ける",
    async () => {
      // 1日1万本なら1年で365万行。誰も見ない行で D1 の枠が埋まる
      onTick = (n) => {
        if (n >= 2) {
          tickResult = {
            stopRequested: false,
            applied: true,
            running: 0,
            finished: [
              { id: "a1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
              { id: "a2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
            ],
          };
        }
      };
      await runRetryGenerationJob(job, retry, null);
      expect(pruned).toBeGreaterThan(0);
      // 掃除は本題ではないので、実行そのものは通常どおり終わる
      expect(finalized?.status).toBe("done");
    },
    20_000,
  );

  it(
    "担当を起こし、結果が届いたら数え、目標に届いたら要約を確定する",
    async () => {
      onTick = (n) => {
        if (n === 1) return; // 1回目: まだ何も走っていない
        if (n === 2) {
          // 起こした分が走っている
          tickResult = { ...idle, running: spawned.flat().length };
          return;
        }
        // 3回目: 目標ぶんの成功が届く
        tickResult = {
          stopRequested: false,
          applied: true,
          running: 0,
          finished: [
            { id: "a1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
            { id: "a2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
          ],
        };
      };

      const out = await runRetryGenerationJob(job, retry, null);

      // 枠は4。担当1つが4本まとめて引き受ける（実行体を分けると
      // 待ち時間が並列数だけ倍に課金されるため）
      expect(spawned.length).toBe(1);
      expect(spawned[0]).toHaveLength(4);
      expect(inserted.length).toBe(4);
      expect(failed).toEqual([]);
      // 起こす前に行を作っている
      expect(inserted.map((a) => a.seq)).toEqual([1, 2, 3, 4]);
      // 見出しに数が載っている
      const last = parseRetryProgress(tickCalls[tickCalls.length - 1]);
      expect(last?.slots).toBe(4);
      expect(out).toEqual({ done: true });
      expect(finalized?.status).toBe("done");
      expect(finalized?.content).toContain("成功 2件");
    },
    20_000,
  );

  it(
    "1回の往復で起こしすぎない（見出しを打ち直せなくなるため）",
    async () => {
      onTick = (n) => {
        if (n >= 2) {
          // 起こした分をそのまま走っていることにして、2回目で終わらせる
          tickResult = {
            stopRequested: false,
            applied: true,
            running: 0,
            finished: [
              { id: "a1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
              { id: "a2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
            ],
          };
        }
      };
      await runRetryGenerationJob(
        job,
        { ...retry, concurrency: 100 },
        null,
      );
      // 枠100・Poe → 12本ずつ引き受けるので担当は9つ。1回の往復で起こす
      // 担当の数（12）も超えない
      expect(spawned.length).toBeLessThanOrEqual(12);
      expect(spawned.flat().length).toBeLessThanOrEqual(100);
      expect(spawned[0]).toHaveLength(12);
      for (const group of spawned) expect(group.length).toBeLessThanOrEqual(12);
    },
    20_000,
  );

  it(
    "ヘッダがすぐ返る上流には、担当1つにもっと多く持たせる",
    async () => {
      // 依頼1本あたりの実行体の時間は「生成時間 ÷ 同時数」なので、
      // ここが増えるほど無料枠で回せる本数が増える
      onTick = (n) => {
        if (n >= 2) {
          tickResult = {
            stopRequested: false,
            applied: true,
            running: 0,
            finished: [
              { id: "a1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
              { id: "a2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
            ],
          };
        }
      };
      await runRetryGenerationJob(
        { ...(job as unknown as Record<string, unknown>), model: "google/gemini-2.5-flash-image" } as never,
        { ...retry, concurrency: 100 },
        null,
      );
      expect(spawned[0]).toHaveLength(24);
    },
    20_000,
  );

  it(
    "設定の同時数を担当へ渡す（渡さないと自動のまま走って費用が変わらない）",
    async () => {
      onTick = (n) => {
        if (n >= 2) {
          tickResult = {
            stopRequested: false,
            applied: true,
            running: 0,
            finished: [
              { id: "a1", kind: "success", detail: null, wait_ml: null, message_id: "m1" },
              { id: "a2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
            ] as never,
          };
        }
      };
      await runRetryGenerationJob(
        { ...(job as unknown as Record<string, unknown>), workerConcurrency: 10 } as never,
        { ...retry, concurrency: 100 },
        null,
      );
      expect(spawnedJobs[0]?.workerConcurrency).toBe(10);
      // 同時10本なら2波ぶん＝20本を引き受ける
      expect(spawned[0]).toHaveLength(20);
    },
    20_000,
  );

  it(
    "見出しの行を失ったら、起こすのをやめて確定も書かない",
    async () => {
      tickResult = { ...idle, applied: false };
      const out = await runRetryGenerationJob(job, retry, null);
      expect(spawned).toEqual([]);
      expect(out).toEqual({ done: true });
      expect(finalized).toBeNull();
    },
    20_000,
  );

  it(
    "起こせなかった行は不調として決着させ、走っていないまま待たない",
    async () => {
      const { env } = await import("cloudflare:workers");
      const gen = (env as { GENERATOR: { get: unknown } }).GENERATOR;
      const original = gen.get;
      gen.get = () => ({
        fetch: async () => new Response("no", { status: 500 }),
      });
      try {
        onTick = (n) => {
          if (n >= 3) {
            tickResult = {
              stopRequested: false,
              applied: true,
              running: 0,
              finished: [
                { id: "a1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
                { id: "a2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
              ],
            };
          }
        };
        await runRetryGenerationJob(job, retry, null);
        // 作った行は全部決着させている（走っていない担当を待ち続けない）
        expect(failed.length).toBe(inserted.length);
      } finally {
        gen.get = original;
      }
    },
    20_000,
  );
});

/**
 * アラームが再送されて途中経過が無いまま再入したとき。旧方式のための
 * 番人がここで実行を殺していた（`shouldFinalizeLostRun`）。司令役の側は
 * D1 の記録から組み直し、走っている担当を数えて投げ直さないこと。
 */
describe("途中経過が無いまま再入する", () => {
  it(
    "D1 の記録から数え直し、走っている担当のぶんは投げ直さない",
    async () => {
      // 既に4本走っていて、拒否が6件・成功0件まで進んでいた
      snapshot = {
        counts: { success: 0, refused: 6, transient: 2, fatal: 0 },
        launched: 10,
        lastSeq: 10,
        firstRefusal: "だめです",
        startedAt: 1_000,
      };
      onTick = (n) => {
        if (n === 1) {
          tickResult = { ...idle, running: 4 };
          return;
        }
        tickResult = {
          stopRequested: false,
          applied: true,
          running: 0,
          finished: [
            { id: "x1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
            { id: "x2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
          ],
        };
      };

      const out = await runRetryGenerationJob(job, retry, null);

      // 枠は4で、既に4本走っている。1本も投げ直さない
      expect(spawned).toEqual([]);
      expect(inserted).toEqual([]);
      // 数え直した分が見出しに載る（拒否6は D1 から）
      const first = parseRetryProgress(tickCalls[0]);
      expect(first?.refusals).toBe(6);
      expect(first?.attempts).toBe(6);
      expect(first?.transients).toBe(2);
      expect(out).toEqual({ done: true });
      // 開始時刻は記録が持つ。再入しても同じ時間帯で Poe の消費を数える
      expect(poePoints).toHaveBeenCalled();
      for (const call of poePoints.mock.calls) {
        expect(call[1]).toBe(1_000);
      }
    },
    20_000,
  );

  it(
    "ここまでの Poe の消費を先に取り、月間上限の判定に足す",
    async () => {
      // Poe は消費が実行の最後にまとめて載るので、走っているあいだの
      // 判定は台帳を見ても実行の分が見えない。再入の頭で取り直す
      poePoints.mockResolvedValue({ points: 500 });
      snapshot = {
        counts: { success: 0, refused: 6, transient: 0, fatal: 0 },
        launched: 6,
        lastSeq: 6,
        firstRefusal: null,
        startedAt: 1_000,
      };
      onTick = (n) => {
        if (n === 1) return;
        tickResult = {
          stopRequested: false,
          applied: true,
          running: 0,
          finished: [
            { id: "x1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
            { id: "x2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
          ],
        };
      };
      await runRetryGenerationJob(job, retry, null);
      expect(monthlyLimit).toHaveBeenCalled();
      expect(monthlyLimit.mock.calls[0][1]).toEqual({
        points: 500,
        costUsd: null,
      });
    },
    20_000,
  );

  it(
    "空きがあるぶんだけ起こす（記録の続きの番号から）",
    async () => {
      snapshot = {
        counts: { success: 0, refused: 3, transient: 0, fatal: 0 },
        launched: 3,
        lastSeq: 3,
        firstRefusal: null,
        startedAt: 1_000,
      };
      onTick = (n) => {
        if (n === 1) {
          tickResult = { ...idle, running: 1 };
          return;
        }
        tickResult = {
          stopRequested: false,
          applied: true,
          running: 0,
          finished: [
            { id: "x1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
            { id: "x2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
          ],
        };
      };
      await runRetryGenerationJob(job, retry, null);
      // 枠4・走っている1本 → 3本だけ。担当1つがまとめて引き受ける
      expect(spawned.length).toBe(1);
      expect(spawned[0]).toHaveLength(3);
      expect(inserted.map((a) => a.seq)).toEqual([4, 5, 6]);
    },
    20_000,
  );
});

/**
 * 1本担当。引き受けた依頼を、1つの実行体の中で同時に回す。
 *
 * ここが「1依頼＝1実行体」だったとき、待ち時間が並列数だけ倍に課金され、
 * 368本の実行1回で無料枠の6割を使い切って止まった。同時数は接続の
 * 上限（6本）まで、引き受けた分は全部決着させること。
 */
describe("1本担当", () => {
  const attemptJob = (ids: string[]) =>
    ({
      kind: "attempt",
      attemptIds: ids,
      statusId: "s1",
      conversationId: "c1",
      model: "poe:Imagen",
      web: false,
      imageOutput: true,
      paramsState: null,
      messages: [],
    }) as never;

  it(
    "引き受けた分を全部投げ、同時に走るのは6本まで",
    async () => {
      const ids = Array.from({ length: 12 }, (_, i) => `a${i}`);
      await runAttemptJob(attemptJob(ids));
      expect(upstream).toHaveBeenCalledTimes(12);
      expect(attemptCalls.peak).toBe(6);
      // 12本とも結果を書いている（司令役が待ち続けないように）
      expect(finished.map((f) => f.id).sort()).toEqual([...ids].sort());
      expect(finished.every((f) => f.kind === "refused")).toBe(true);
      expect(failed).toEqual([]);
    },
    30_000,
  );

  it(
    "通信の枠が尽きたら、引き受けたまま投げていない分を決着させる",
    async () => {
      // 決着させないと、司令役は走っていない担当を待ち続けて終われない
      launchAllowance = 3;
      const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
      await runAttemptJob(attemptJob(ids));
      expect(upstream).toHaveBeenCalledTimes(3);
      expect(failed).toHaveLength(9);
      expect(finished).toHaveLength(3);
      // 投げた分と投げなかった分を合わせて、引き受けた数と一致する
      expect(failed.length + finished.length).toBe(ids.length);
    },
    30_000,
  );

  it(
    "ヘッダがすぐ返る上流なら、もっと同時に投げる",
    async () => {
      // OpenRouter は待っているあいだ「処理中」の行を送るので、
      // 「同時にヘッダを待てる接続は6本」の縛りに当たらない
      const ids = Array.from({ length: 24 }, (_, i) => `o${i}`);
      await runAttemptJob({
        ...(attemptJob(ids) as unknown as Record<string, unknown>),
        model: "google/gemini-2.5-flash-image",
      } as never);
      expect(upstream).toHaveBeenCalledTimes(24);
      expect(attemptCalls.peak).toBeGreaterThan(6);
    },
    60_000,
  );

  it(
    "上流が失敗しても、引き受けた分は決着させる",
    async () => {
      upstream.mockRejectedValueOnce(new Error("こわれた"));
      await runAttemptJob(attemptJob(["b1", "b2"]));
      expect(finished).toHaveLength(2);
      expect(finished.find((f) => f.kind === "transient")?.detail).toContain(
        "こわれた",
      );
    },
    30_000,
  );
});

/**
 * いちばん外側の柵（上限試行回数の3倍）。試行に数えない一時的な不調が
 * 続いても、上流へ投げる本数はここで止まる。担当1つに複数の依頼を
 * 持たせるようになったので、**起こした担当の数ではなく依頼の数**で
 * 数えないと、柵が担当の数ぶん（最大12倍）緩む。
 */
describe("上流への本数の柵", () => {
  it(
    "不調が続いても、投げた依頼の数で打ち切る",
    async () => {
      onTick = () => {
        // 結果は全部「一時的な不調」。試行には数えないので、
        // 止まる理由は柵しかない
        tickResult = {
          stopRequested: false,
          applied: true,
          running: 0,
          finished: spawned
            .flat()
            .slice(finishedIds.size)
            .map((id) => {
              finishedIds.add(id);
              return {
                id,
                kind: "transient" as const,
                detail: "混雑",
                wait_ms: 1,
                message_id: null,
              };
            }),
        };
      };
      const finishedIds = new Set<string>();
      await runRetryGenerationJob(
        job,
        { target: 99, maxAttempts: 10, concurrency: 100, smartPercent: null },
        null,
      );
      // 柵は 10 × 3 = 30本
      expect(spawned.flat().length).toBe(30);
      expect(finalized?.error).toContain("柵");
    },
    60_000,
  );
});

/**
 * 実測を要約に出す。依頼1本あたりの実行体の時間は
 * 「かかった時間 ÷ 担当1つの同時数」で、無料枠（1日 約104,000秒）の
 * 消費がこれで決まる。同時数をいくつにすべきかを、憶測ではなく
 * ここの数字から決められるようにする。
 */
describe("使った時間の実測", () => {
  it(
    "1本あたりの秒数と、無料枠に対する割合を要約に出す",
    async () => {
      // 20本・合計3600秒 → 1本180秒。同時6本なら担当のぶんは600秒
      durations = { count: 20, totalMs: 3_600_000, doMs: 0 };
      // 司令役も400秒起きていた。歯止めはこれも数えているので、
      // 担当のぶんだけ見せると枠の4割が見えないまま消える
      coordinatorTotalMs = 400_000;
      onTick = (n) => {
        if (n >= 2) {
          tickResult = {
            stopRequested: false,
            applied: true,
            running: 0,
            finished: [
              { id: "a1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
              { id: "a2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
            ],
          };
        }
      };
      await runRetryGenerationJob(job, retry, null);
      // 取り分の記録が無い古い実行では、実効は出せないので出さない
      expect(finalized?.content).toContain("1本あたり 180.0秒（同時 6本）");
      expect(finalized?.content).not.toContain("実効");
      expect(finalized?.content).toContain(
        "実行体の時間 1,000秒（担当 600秒＋司令役 400秒）",
      );
      // 割合も合計で出す（600秒ぶんの 0.6% ではない）
      expect(finalized?.content).toContain("1日の無料枠の 1.0%");
    },
    20_000,
  );

  it(
    "担当が書いた取り分があれば、それをそのまま出す（割り直さない）",
    async () => {
      // 並列数が担当の同時数より小さいと、担当は同時数より少ない依頼しか
      // 引き受けない。ここで同時数で割り直すと消費を少なく見積もる
      durations = { count: 20, totalMs: 3_600_000, doMs: 1_200_000 };
      onTick = (n) => {
        if (n >= 2) {
          tickResult = {
            stopRequested: false,
            applied: true,
            running: 0,
            finished: [
              { id: "a1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
              { id: "a2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
            ],
          };
        }
      };
      await runRetryGenerationJob(job, retry, null);
      // 3,600秒 ÷ 6 = 600秒 ではなく、記録された 1,200秒
      expect(finalized?.content).toContain("実行体の時間 1,200秒");
      expect(finalized?.content).not.toContain("実行体の時間 600秒");
      // 実効の同時数＝かかった時間 ÷ 実行体の時間。設定が6でも実際に
      // 重なっていたのは3本、と読める（ヘッダまでの時間より直に答える）
      expect(finalized?.content).toContain("同時 6本・実効 3.0本");
    },
    20_000,
  );

  it(
    "実測が取れなくても要約は出す",
    async () => {
      durations = { count: 0, totalMs: 0, doMs: 0 };
      onTick = (n) => {
        if (n >= 2) {
          tickResult = {
            stopRequested: false,
            applied: true,
            running: 0,
            finished: [
              { id: "a1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
              { id: "a2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
            ],
          };
        }
      };
      await runRetryGenerationJob(job, retry, null);
      expect(finalized?.content).toContain("成功 2件");
      expect(finalized?.content).not.toContain("1本あたり");
    },
    20_000,
  );
});

/**
 * 応答ヘッダが返るまでの時間を要約に出す。
 *
 * かかった時間だけでは、順番待ちで遅いのか生成が遅いのかを区別できない
 * （拒否が速いプロンプトと成功が混ざるプロンプトで秒数が変わる）。
 * ヘッダまでの時間は待たされているときだけ伸びるので、プロンプトに
 * 依らず「7本目以降が順番待ちになっているか」が読める。
 */
describe("ヘッダまでの時間", () => {
  const finishAll = (n: number) => {
    onTick = (t) => {
      if (t >= n) {
        tickResult = {
          stopRequested: false,
          applied: true,
          running: 0,
          finished: [
            { id: "a1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
            { id: "a2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
          ],
        };
      }
    };
  };

  it(
    "平均と最長を出す",
    async () => {
      headerTimes = { count: 24, avgMs: 1_200, maxMs: 2_500 };
      finishAll(2);
      await runRetryGenerationJob(job, retry, null);
      expect(finalized?.content).toContain("ヘッダまで 平均 1.2秒・最長 2.5秒");
    },
    20_000,
  );

  it(
    "記録が無ければ出さない",
    async () => {
      headerTimes = { count: 0, avgMs: 0, maxMs: 0 };
      finishAll(2);
      await runRetryGenerationJob(job, retry, null);
      expect(finalized?.content).not.toContain("ヘッダまで");
    },
    20_000,
  );
});

/**
 * 1日に使ってよい「実行体が起きている時間」の歯止め。
 *
 * Durable Object の無料枠を使い切ると**どの生成も始められなくなり、
 * 翌0時（UTC）まで戻らない**。実際に2日続けて締め出された。上流の課金と
 * 違って台帳に載らないので、自分で数えて手前で止めるしかない。
 */
describe("1日の実行体の時間の歯止め", () => {
  const finishAll = (n: number) => {
    onTick = (t) => {
      if (t >= n) {
        tickResult = {
          stopRequested: false,
          applied: true,
          running: 0,
          finished: [
            { id: "a1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
            { id: "a2", kind: "success", detail: null, wait_ms: null, message_id: "m2" },
          ],
        };
      }
    };
  };

  it(
    "上限に達していたら、1本も起こさずに打ち切る",
    async () => {
      dailyDoMs = 95_000_000; // 95,000秒
      // 前の区切りで起こした担当がまだ走っている（＝すぐには終われない）。
      // この往復のあいだ、新しく起こさないことを見る
      snapshot = { ...snapshot, launched: 4, lastSeq: 4 };
      tickResult = { ...idle, running: 4 };
      onTick = (n) => {
        if (n >= 4) tickResult = { ...idle, running: 0 };
      };
      const out = await runRetryGenerationJob(
        { ...(job as unknown as Record<string, unknown>), dailyDoSecondsBudget: 90_000 } as never,
        retry,
        null,
      );
      expect(spawned).toEqual([]);
      expect(inserted).toEqual([]);
      expect(out).toEqual({ done: true });
      // 成功0件なので要約はエラー欄に載る
      expect(finalized?.status).toBe("error");
      expect(finalized?.error).toContain("打ち切りました");
      expect(finalized?.error).toContain(
        "1日に使ってよい実行体の時間の上限に達しました",
      );
      expect(finalized?.error).toContain("1日の実行体の時間の上限（90,000秒）");
    },
    20_000,
  );

  it(
    "上限に届いていなければ、いつも通り起こす",
    async () => {
      dailyDoMs = 10_000_000; // 10,000秒
      finishAll(2);
      await runRetryGenerationJob(
        { ...(job as unknown as Record<string, unknown>), dailyDoSecondsBudget: 90_000 } as never,
        retry,
        null,
      );
      expect(spawned.flat()).toHaveLength(4);
      expect(dailyChecks).toBeGreaterThan(0);
      expect(finalized?.content).not.toContain("1日に使ってよい実行体の時間");
    },
    20_000,
  );

  it(
    "上限を 0（切）にしたら、集計そのものを読まない",
    async () => {
      // D1 を1件使う問い合わせなので、使わない設定では投げない
      dailyDoMs = 95_000_000;
      finishAll(2);
      await runRetryGenerationJob(
        { ...(job as unknown as Record<string, unknown>), dailyDoSecondsBudget: 0 } as never,
        retry,
        null,
      );
      expect(dailyChecks).toBe(0);
      expect(spawned.flat()).toHaveLength(4);
    },
    20_000,
  );

  it(
    "司令役が起きていた時間も数に入れる",
    async () => {
      // 担当のぶんだけ数えると、司令役が起きている時間（無料枠を同じだけ
      // 食う）が丸ごと帳簿から漏れる
      finishAll(2);
      await runRetryGenerationJob(job, retry, null);
      expect(coordinatorMs.length).toBeGreaterThan(0);
      expect(coordinatorMs.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    },
    20_000,
  );
});

/**
 * 空いた枠を1本ずつ埋めない。
 *
 * 1本だけ起こすと、その担当は1本しか持たないので、生成時間まるごとが
 * その1本の実行体の時間になる——**依頼ごとに実行体を分けるのと同じ**で、
 * 禁じているはずの形に戻る。実測（並列8・24秒の生成）では、最初の一束の
 * あと成功が返るたびに1本ずつ起こしていて、実効の同時数が 2.5本まで
 * 落ちていた。
 */
describe("空きが溜まってから起こす", () => {
  it(
    "1本空いただけでは起こさず、半分空いたらまとめて起こす",
    async () => {
      const wide = { target: 20, maxAttempts: 50, concurrency: 8, smartPercent: null };
      onTick = (n) => {
        if (n === 1) return; // まだ何も走っていない
        if (n === 2 || n === 3) {
          // 1本だけ返った。空きは1——ここで起こすと1本持ちの担当になる
          tickResult = {
            stopRequested: false,
            applied: true,
            running: 7,
            finished:
              n === 2
                ? [{ id: "r1", kind: "refused", detail: "だめ", wait_ms: null, message_id: null }]
                : [],
          };
          return;
        }
        if (n === 4) {
          // さらに3本返って空きは4＝枠の半分
          tickResult = {
            stopRequested: false,
            applied: true,
            running: 4,
            finished: [
              { id: "r2", kind: "refused", detail: null, wait_ms: null, message_id: null },
              { id: "r3", kind: "refused", detail: null, wait_ms: null, message_id: null },
              { id: "r4", kind: "refused", detail: null, wait_ms: null, message_id: null },
            ],
          };
          return;
        }
        // 残りが全部成功して目標に届き、実行が終わる
        tickResult = {
          stopRequested: false,
          applied: true,
          running: 0,
          finished: Array.from({ length: 20 }, (_, i) => ({
            id: `ok${i}`,
            kind: "success" as const,
            detail: null,
            wait_ms: null,
            message_id: `m${i}`,
          })),
        };
      };

      await runRetryGenerationJob(job, wide, null);

      // 最初の一束8本と、半分空いてからの4本。1本ずつの担当は作らない
      expect(spawned.map((g) => g.length)).toEqual([8, 4]);
      expect(spawned.every((g) => g.length > 1)).toBe(true);
    },
    30_000,
  );

  it(
    "何も走っていなければ、1本でも起こす（待つ相手がいない）",
    async () => {
      // 目標まであと1本。ここで待つと実行が止まったまま終わらない
      const nearly = { target: 1, maxAttempts: 50, concurrency: 8, smartPercent: null };
      onTick = (n) => {
        if (n >= 2) {
          tickResult = {
            stopRequested: false,
            applied: true,
            running: 0,
            finished: [
              { id: "s1", kind: "success", detail: null, wait_ms: null, message_id: "m1" },
            ],
          };
        }
      };
      await runRetryGenerationJob(job, nearly, null);
      expect(spawned.length).toBeGreaterThan(0);
      expect(finalized?.status).toBe("done");
    },
    30_000,
  );
});

/**
 * 担当が書く「この依頼ぶんの取り分」。
 *
 * 課金されるのは実行体が起きていた壁時計の時間なので、ある瞬間の1秒は
 * その瞬間に走っていた本数で頭割りするのが正しい。固定の数（設定の
 * 同時数・引き受けた本数）で割ると合わない——起こす間隔を空けているので
 * 全部が重なるとは限らず、終わりぎわに1本だけ残ればその1本がその間を
 * 丸ごと負う。少なく見積もる向きに外すと、歯止めが効かないまま枠を
 * 使い切る。
 */
describe("依頼1本ぶんの実行体の時間", () => {
  const attemptJob = (ids: string[], workerConcurrency: number) =>
    ({
      kind: "attempt",
      attemptIds: ids,
      statusId: "s1",
      conversationId: "c1",
      model: "poe:Imagen",
      web: false,
      imageOutput: true,
      paramsState: null,
      messages: [],
      workerConcurrency,
    }) as never;

  const takes = (ms: number) =>
    upstream.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, ms));
      return { kind: "refused" as const, text: "だめです", usageJson: null };
    });

  it(
    "取り分の合計は、実行体が起きていた時間と一致する",
    async () => {
      // ここが合っていることだけが、歯止めの根拠になる。合計が壁時計より
      // 小さければ、その差はそのまま「数えずに使った枠」になる
      const t0 = Date.now();
      await runAttemptJob(
        attemptJob(["a1", "a2", "a3", "a4", "a5", "a6"], 6),
      );
      const wall = Date.now() - t0;
      const sum = finished.reduce((a, f) => a + (f.doMs ?? 0), 0);
      expect(finished).toHaveLength(6);
      expect(sum).toBeGreaterThan(wall * 0.85);
      expect(sum).toBeLessThan(wall * 1.05);
    },
    60_000,
  );

  it(
    "終わりぎわに1本だけ残ったら、その間はその1本が丸ごと負う",
    async () => {
      // 同時数6で割ると、この居残りを6分の1にしか数えない
      takes(2_500); // slow
      takes(500); // f1
      takes(500); // f2
      await runAttemptJob(attemptJob(["slow", "f1", "f2"], 6));
      const by = new Map(finished.map((f) => [f.id, f.doMs ?? 0]));
      expect(by.size).toBe(3);
      // 重なっていたのは最初の1秒足らずだけ。残り1.6秒は slow が全部負う
      expect(by.get("slow")!).toBeGreaterThan(1_800);
      expect(by.get("slow")!).toBeLessThan(2_500);
      // 速い2本は重なっていた分だけ
      expect(by.get("f1")!).toBeLessThan(400);
      expect(by.get("f2")!).toBeLessThan(400);
    },
    60_000,
  );
});
