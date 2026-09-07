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
const spawned: string[] = [];
const inserted: { id: string; seq: number }[] = [];
const failed: string[] = [];
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
      get: (id: { name: string }) => ({
        fetch: async () => {
          spawned.push(id.name);
          return new Response("{}", { status: 202 });
        },
      }),
    },
  },
  DurableObject: class {},
}));

vi.mock("../../app/lib/db.server", () => ({
  createRetryRun: vi.fn(async () => {}),
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
  sweepLostRetryAttempts: vi.fn(async () => 0),
  finishRetryAttempt: vi.fn(async () => true),
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

vi.mock("../../app/lib/generation.server", () => ({
  runAttempt: vi.fn(),
  expandAttachments: vi.fn(async (m: unknown) => m),
  promptOf: vi.fn(() => null),
  createBudget: vi.fn(() => ({ spend: () => {} })),
  createRateLimitGate: vi.fn(() => ({})),
  captureGeneratedImages: vi.fn(),
  recordRefusalUsage: vi.fn(),
}));

const poePoints = vi.fn(async (): Promise<{ points: number; costUsd?: number } | null> => null);
vi.mock("../../app/lib/openrouter.server", () => ({
  POE_PREFIX: "poe:",
  fetchPoeRunPoints: poePoints,
}));

const { runRetryGenerationJob } = await import("../../app/lib/retry-run.server");
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
  inserted.length = 0;
  failed.length = 0;
  tickCalls = [];
  finalized = null;
  onTick = null;
  tickResult = { ...idle };
  poePoints.mockClear();
  poePoints.mockResolvedValue(null);
  monthlyLimit.mockClear();
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
    "担当を起こし、結果が届いたら数え、目標に届いたら要約を確定する",
    async () => {
      onTick = (n) => {
        if (n === 1) return; // 1回目: まだ何も走っていない
        if (n === 2) {
          // 起こした分が走っている
          tickResult = { ...idle, running: spawned.length };
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

      // 並列数ぶん起こしている（枠は4）
      expect(spawned.length).toBe(4);
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
      expect(spawned.length).toBeLessThanOrEqual(12);
      expect(spawned.length).toBeGreaterThan(1);
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
      // 枠4・走っている1本 → 3本だけ起こす。番号は記録の続き
      expect(spawned.length).toBe(3);
      expect(inserted.map((a) => a.seq)).toEqual([4, 5, 6]);
    },
    20_000,
  );
});
