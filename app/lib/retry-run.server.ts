/**
 * 「成功するまで生成」の実行体。司令役（runRetryGenerationJob）と
 * 1本担当（runAttemptJob）。
 *
 * 以前は1つの実行の中で全部の依頼を投げていた。すると Cloudflare の
 * 「1回の呼び出しあたり」の制限に並列が縛られる: 応答ヘッダを同時に
 * 待てる接続は6本（Poe は画像ができるまでヘッダを返さない）、外部への
 * 通信は50件、実行は15分。拒否率が高くても大量に並列で投げて時間を
 * 節約する、というこの機能の目的と噛み合わなかった。
 *
 * 依頼1本ごとに別の実行（別の Durable Object）へ渡すと、制限は1本ごとに
 * 丸ごと使える。司令役は「いま何本走らせるか」を決めて担当を起こす
 * だけで、走っている依頼を抱えない。担当は1本投げて、返事を受け取り、
 * 成功なら会話に保存して画像を取り込み、結果を D1 に書いて終わる。
 * 司令役は D1 の記録を毎秒読んで数え直す。実行同士は記憶を共有しない
 * ので、進み具合と「次の成功をどこへ繋ぐか」は D1 に置く（schema.ts の
 * retry_runs / retry_attempts）。
 *
 * 司令役の実行も15分で区切られるが、走っている依頼を抱えていないので
 * 区切りで何も失わない。途中経過を保存して次のアラームで続ける。
 */
import { env } from "cloudflare:workers";
import { POE_PREFIX, fetchPoeRunPoints, type ChatMessage } from "./openrouter.server";
import type { ParamsState } from "./params";
import {
  RETRY_ALARM_WALL_MS,
  RETRY_ATTEMPT_DEADLINE_MS,
  RETRY_STALLED_CHUNK_LIMIT,
  afterAttemptSettled,
  formatRetryProgress,
  onTransientFailure,
  retryRequestCap,
  type RetryConfig,
} from "./retry";
import { planRetrySlots } from "./retry-slots";
import { checkMonthlyLimit } from "./limit.server";
import {
  appendRetrySuccess,
  createRetryRun,
  finalizeGeneration,
  finishRetryAttempt,
  insertRetryAttempt,
  markRetryAttemptsProcessed,
  retryRunSnapshot,
  rewriteMessageContent,
  sweepLostRetryAttempts,
  tickRetryRun,
  type RetryAttemptRow,
} from "./db.server";
import {
  captureGeneratedImages,
  createBudget,
  createRateLimitGate,
  expandAttachments,
  promptOf,
  recordRefusalUsage,
  runAttempt,
  type GenerationJob,
} from "./generation.server";

/** 1本担当の実行へ渡す仕事。 */
export interface AttemptJob {
  kind: "attempt";
  attemptId: string;
  statusId: string;
  conversationId: string;
  model: string;
  web: boolean;
  webTools?: boolean;
  imageOutput?: boolean;
  paramsState: ParamsState | null;
  messages: ChatMessage[];
}

/**
 * チャンクをまたいで引き継ぐ、司令役の途中経過。
 *
 * 数え上げは続きの実行の頭で D1 から取り直すので、ここに持つ数は
 * その実行の中で進めるための写し。DO のストレージへそのまま入れる
 * ため小さく保つ。
 */
export interface RetryRunState {
  startedAt: number;
  successes: number;
  /** 消費した試行（成功＋拒否＋空）。一時的な不調は数えない。 */
  attempts: number;
  refusals: number;
  emptyResponses: number;
  /** 一時的な不調の数。試行には数えない。 */
  transients: number;
  /** 起こした担当の数（投げた本数の柵に使う）。 */
  launched: number;
  lastSeq: number;
  rateLimitRounds: number;
  pauseUntil: number;
  firstRefusal: string | null;
  lastError: string | null;
  /** 直らないエラーを受けた。続きの実行でも投げない。 */
  fatal: boolean;
  provisional: { points: number; costUsd: number | null } | null;
  stalledChunks: number;
}

export type JobOutcome =
  | { done: true }
  | { done: false; state: RetryRunState };

/** 司令役の毎秒の間隔と、続きの実行1回の長さ。 */
const TICK_MS = 1_000;
/** ここまで刻んだら間隔を広げる（内部の呼び出し回数の上限のため）。 */
const TICK_FAST_COUNT = 120;
const TICK_SLOW_MS = 3_000;
/**
 * 司令役の続きの実行1回の長さ。15分の壁より十分手前で区切る。
 * 走っている依頼は担当が持っているので、ここで区切っても失われない。
 */
const COORDINATOR_CHUNK_MS = 10 * 60_000;
/** 担当を起こす間隔。上流へ同時に当たるのを避ける。 */
const SPAWN_STAGGER_MS = 200;
/** 失われた担当を掃く間隔（tick 数）。 */
const SWEEP_EVERY_TICKS = 60;
/**
 * 担当の実行が失われたとみなす経過時間。担当は12分の締め切りで必ず
 * 結果を書き、実行そのものは15分で止められる。それを過ぎて決まって
 * いない行は、実行が失われたか、書けなかったか。
 */
const LOST_AFTER_MS = RETRY_ALARM_WALL_MS + 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function initialState(): RetryRunState {
  return {
    startedAt: Date.now(),
    successes: 0,
    attempts: 0,
    refusals: 0,
    emptyResponses: 0,
    transients: 0,
    launched: 0,
    lastSeq: 0,
    rateLimitRounds: 0,
    pauseUntil: 0,
    firstRefusal: null,
    lastError: null,
    fatal: false,
    provisional: null,
    stalledChunks: 0,
  };
}

/** 担当の実行を起こす。 */
async function spawnAttempt(job: GenerationJob, attemptId: string): Promise<void> {
  const attempt: AttemptJob = {
    kind: "attempt",
    attemptId,
    statusId: job.assistantMessageId,
    conversationId: job.conversationId,
    model: job.model,
    web: job.web,
    webTools: job.webTools,
    imageOutput: job.imageOutput,
    paramsState: job.paramsState,
    messages: job.messages,
  };
  const stub = env.GENERATOR.get(env.GENERATOR.idFromName(attemptId));
  const res = await stub.fetch("https://generator/attempt", {
    method: "POST",
    body: JSON.stringify(attempt),
  });
  if (!res.ok) throw new Error(`担当の実行を起こせませんでした (${res.status})`);
}

/**
 * 司令役。1回の呼び出しで**1チャンクぶん**を進めて返す。
 * 続きがあるなら done: false を返し、呼び出し元（DO のアラーム）が
 * 途中経過を保存して次のアラームで続きを走らせる。
 */
export async function runRetryGenerationJob(
  job: GenerationJob,
  retry: RetryConfig,
  previous: RetryRunState | null,
): Promise<JobOutcome> {
  const isPoe = job.model.startsWith(POE_PREFIX);
  const modelName = isPoe ? job.model.slice(POE_PREFIX.length) : job.model;
  const statusId = job.assistantMessageId;
  const state: RetryRunState = { ...initialState(), ...(previous ?? {}) };
  const requestCap = retryRequestCap(retry.maxAttempts);
  const chunkStartedAt = Date.now();

  let stopped = false;
  /** 見出しの行がもうこの実行のものではない（消えた・確定済み）。 */
  let lost = false;
  let touchFailed = false;
  let budgetStopped = false;
  let running = 0;
  let ticks = 0;
  let progressed = false;

  // 実行の記録（無ければ作る）と、続きの実行の頭の数え直し。
  // 数え上げは D1 が本体。担当が書いた行を集計し、集計に含めた行は
  // 「数えた」にして、この後の毎秒の読みで二重に数えない
  await createRetryRun({ statusId, conversationId: job.conversationId, now: state.startedAt });
  const snapshot = await retryRunSnapshot(statusId);
  state.successes = snapshot.counts.success;
  state.refusals = snapshot.counts.refused;
  state.attempts = snapshot.counts.success + snapshot.counts.refused;
  state.transients = snapshot.counts.transient;
  state.launched = snapshot.launched;
  state.lastSeq = snapshot.lastSeq;
  state.firstRefusal = state.firstRefusal ?? snapshot.firstRefusal;
  if (snapshot.counts.fatal > 0) state.fatal = true;
  // 空の応答と拒否文は集計では分けられない（detail の有無で分ける）ので、
  // 続きの実行では refusals にまとめて数える

  // Poe: 続きの実行では、ここまでの消費を月間上限の判定に足せるよう取る
  if (isPoe && previous && state.attempts > 0) {
    const soFar = await fetchPoeRunPoints(modelName, state.startedAt);
    if (soFar) {
      state.provisional = { points: soFar.points, costUsd: soFar.costUsd ?? null };
    }
  }

  const overBudget = async (): Promise<boolean> => {
    try {
      return (await checkMonthlyLimit(Date.now(), state.provisional)).blocked;
    } catch {
      return false;
    }
  };

  const slots = (): number =>
    retry.smartPercent != null
      ? planRetrySlots({
          target: retry.target,
          successes: state.successes,
          attempts: state.attempts,
          maxAttempts: retry.maxAttempts,
          cap: retry.concurrency,
          percent: retry.smartPercent,
        })
      : retry.concurrency;

  const waitUntil = () => state.pauseUntil;

  /** 担当が書いた結果を1つ数える。 */
  const absorb = (row: RetryAttemptRow) => {
    progressed = true;
    if (row.kind === "success") {
      state.successes++;
      state.attempts++;
      state.rateLimitRounds = afterAttemptSettled({
        pauseUntil: state.pauseUntil,
        rounds: state.rateLimitRounds,
      }).rounds;
    } else if (row.kind === "refused") {
      state.attempts++;
      if (row.detail && row.detail.trim()) {
        state.refusals++;
        state.firstRefusal ??= row.detail.trim().slice(0, 301);
      } else {
        state.emptyResponses++;
      }
      state.rateLimitRounds = afterAttemptSettled({
        pauseUntil: state.pauseUntil,
        rounds: state.rateLimitRounds,
      }).rounds;
    } else if (row.kind === "transient") {
      // 一時的な不調は試行に数えない。待ちを伸ばしながら投げ直す
      state.transients++;
      state.lastError = row.detail;
      const next = onTransientFailure(
        { pauseUntil: state.pauseUntil, rounds: state.rateLimitRounds },
        { now: Date.now(), waitMs: row.wait_ms ?? undefined },
      );
      state.pauseUntil = next.pauseUntil;
      state.rateLimitRounds = next.rounds;
    } else if (row.kind === "fatal") {
      // 直らない（認証・残高・不正な依頼）。投げ直しても同じなので止める
      state.fatal = true;
      state.lastError = `直らないエラーのため打ち切りました: ${row.detail ?? ""}`;
    }
  };

  /**
   * 毎秒の1往復。見出しの打ち直し（生存確認・停止要求の経路）と、
   * 担当が書いた結果の取り込みを1つの batch で行う。例外は外へ出さない
   * （出すと実行が倒れる。担当は別の実行なので結果は失われないが、
   * 司令役が数え直せるまで進まない）。
   */
  const tick = async (): Promise<void> => {
    ticks++;
    try {
      const t = await tickRetryRun(
        statusId,
        formatRetryProgress({
          target: retry.target,
          successes: state.successes,
          attempts: state.attempts,
          maxAttempts: retry.maxAttempts,
          refusals: state.refusals,
          emptyResponses: state.emptyResponses,
          transients: state.transients,
          running,
          slots: slots(),
          waitSeconds: Math.max(0, Math.ceil((waitUntil() - Date.now()) / 1000)),
          stopping: stopped && running > 0,
        }),
      );
      touchFailed = false;
      if (t.stopRequested) stopped = true;
      if (!t.applied) {
        // 行が消えたか確定済み。会話を消しても投げ続けないよう停止と同じに扱う
        lost = true;
        stopped = true;
      }
      running = t.running;
      if (t.finished.length > 0) {
        for (const row of t.finished) absorb(row);
        await markRetryAttemptsProcessed(t.finished.map((r) => r.id));
      }
    } catch (e) {
      touchFailed = true;
      console.error("[gen] 司令役の生存確認を書けませんでした", statusId, e);
    }
  };

  /** 担当の実行が失われた行を決着させる。 */
  const sweep = async (): Promise<void> => {
    try {
      const swept = await sweepLostRetryAttempts({
        statusId,
        launchedBefore: Date.now() - LOST_AFTER_MS,
        now: Date.now(),
      });
      if (swept > 0) console.warn(`[gen] 担当の実行が失われました: ${swept}本`, statusId);
    } catch {
      // 次の周期で拾う
    }
  };

  await sweep();

  for (;;) {
    await tick();
    if (ticks % SWEEP_EVERY_TICKS === 0) await sweep();

    const canLaunch =
      !stopped && !lost && !touchFailed && !state.fatal && !budgetStopped;
    const wantMore =
      state.successes < retry.target &&
      state.attempts + running < retry.maxAttempts &&
      state.launched < requestCap;

    // 目標に届くまで、上限と並列数の範囲で担当を起こし続ける
    if (canLaunch && wantMore && Date.now() >= waitUntil()) {
      if (await overBudget()) {
        state.lastError = "今月の使用額が上限に達したため打ち切りました";
        budgetStopped = true;
      } else {
        let burst = 0;
        while (
          running < slots() &&
          state.attempts + running < retry.maxAttempts &&
          state.launched < requestCap &&
          !stopped
        ) {
          if (burst > 0) await sleep(SPAWN_STAGGER_MS);
          const attemptId = crypto.randomUUID();
          const seq = state.lastSeq + 1;
          try {
            // 行を先に作る。担当の実行が失われても行は残り、掃除で決着する
            await insertRetryAttempt({ id: attemptId, statusId, seq, now: Date.now() });
            state.lastSeq = seq;
            state.launched++;
            running++;
            progressed = true;
            burst++;
            await spawnAttempt(job, attemptId);
          } catch (e) {
            // 起こせなかった分は一時的な不調として決着させ、待ってから投げ直す
            await finishRetryAttempt({
              id: attemptId,
              kind: "transient",
              detail: `担当の実行を起こせませんでした: ${(e as Error).message}`,
              waitMs: null,
              now: Date.now(),
            }).catch(() => {});
            break;
          }
        }
      }
    }

    // 終わりの判定。走っている担当が残っているあいだは待つ（課金済み）
    const finishedLaunching =
      stopped ||
      lost ||
      state.fatal ||
      budgetStopped ||
      state.successes >= retry.target ||
      state.attempts >= retry.maxAttempts ||
      state.launched >= requestCap;
    if (finishedLaunching && running === 0) break;

    // 続きの実行の区切り。走っている依頼は担当が持っているので失われない
    if (Date.now() - chunkStartedAt > COORDINATOR_CHUNK_MS) {
      state.stalledChunks = progressed ? 0 : state.stalledChunks + 1;
      if (state.stalledChunks >= RETRY_STALLED_CHUNK_LIMIT) {
        state.lastError = `進まないまま${state.stalledChunks}回続いたため打ち切りました${
          touchFailed ? "（進捗を保存できませんでした）" : ""
        }`;
        break;
      }
      if (lost) break;
      console.log(
        `[gen] retry chunk paused: attempts=${state.attempts} successes=${state.successes} running=${running} launched=${state.launched}`,
      );
      return { done: false, state };
    }

    await sleep(ticks < TICK_FAST_COUNT ? TICK_MS : TICK_SLOW_MS);
  }

  if (lost) {
    console.log(
      `[gen] retry run lost its status row: attempts=${state.attempts} successes=${state.successes}`,
    );
    return { done: true };
  }

  const requestsExhausted = state.launched >= requestCap;
  if (requestsExhausted) {
    state.lastError = `上流へ投げた本数が柵（${requestCap}本、一時的な不調を含む）に達したため打ち切りました`;
  }
  const stalled = state.stalledChunks >= RETRY_STALLED_CHUNK_LIMIT;

  // Poe: 消費ポイントは応答に載らないので、実行時間帯の履歴を合計する
  let usageJson: string | null = null;
  if (isPoe && state.attempts > 0) {
    await sleep(1500);
    const total = await fetchPoeRunPoints(modelName, state.startedAt);
    if (total) {
      usageJson = JSON.stringify({ points: total.points, cost: total.costUsd });
    }
  }

  const lines: string[] = [];
  const cutShort = budgetStopped || state.fatal || requestsExhausted || stalled;
  lines.push(
    cutShort
      ? `**打ち切りました** — 成功 ${state.successes}件（目標 ${retry.target}件）・試行 ${state.attempts}回`
      : stopped
        ? `**停止しました** — 成功 ${state.successes}件・試行 ${state.attempts}回`
        : `**完了** — 成功 ${state.successes}件（目標 ${retry.target}件）・試行 ${state.attempts}回（上限 ${retry.maxAttempts}回）`,
  );
  if (budgetStopped) {
    lines.push(
      "今月の使用額が上限に達しました。設定画面から上限を変えるか、今月だけ一時解除できます。",
    );
  } else if (state.fatal) {
    lines.push("直らないエラーを受けたので、その場で止めました。");
  }
  if (state.successes > retry.target) {
    lines.push(
      `目標より ${state.successes - retry.target}件多く受け取りました（並列で走っていた分です）。`,
    );
  }
  if (!stopped && !cutShort && state.successes < retry.target) {
    lines.push(
      `目標に届きませんでした（上限${state.attempts >= retry.maxAttempts ? "の試行回数" : ""}に達しました）。`,
    );
  }
  const breakdown: string[] = [];
  if (state.refusals > 0) breakdown.push(`画像が返らなかった応答 ${state.refusals}回`);
  if (state.emptyResponses > 0) breakdown.push(`空の応答 ${state.emptyResponses}回`);
  if (breakdown.length > 0) lines.push(`\n内訳: ${breakdown.join("・")}`);
  if (state.firstRefusal) {
    lines.push(
      `\n> ${state.firstRefusal.slice(0, 300).replace(/\n+/g, " ")}${
        state.firstRefusal.length > 300 ? "…" : ""
      }`,
    );
  }
  if (state.transients > 0) {
    lines.push(
      `\n一時的な不調（混雑・時間切れ・上流の障害）: ${state.transients}回（試行には数えません）`,
    );
  }
  if (state.lastError) lines.push(`\n最後のエラー: ${state.lastError}`);

  console.log(
    `[gen] retry run finished: attempts=${state.attempts} successes=${state.successes} refusals=${state.refusals} empty=${state.emptyResponses} transients=${state.transients} launched=${state.launched}`,
  );

  const summary = lines.join("\n");
  await finalizeGeneration(statusId, {
    content: state.successes > 0 ? summary : "",
    reasoning: null,
    usageJson,
    kind: "retry",
    status: state.successes > 0 ? "done" : "error",
    error: state.successes > 0 ? null : summary.replace(/\*\*/g, ""),
  });
  return { done: true };
}

/**
 * 1本担当。依頼を1本投げ、結果を D1 に書く。**例外を外へ出さない**——
 * 出すとアラームが再送され、同じ依頼をもう一度投げて二重に課金される。
 * 結果を書けなかった行は、司令役が時間切れで一時的な不調として掃く。
 *
 * 成功は保存できた時点で書く（親の付け替えは1つの batch で原子的）。
 * 画像の取り込みで失敗しても行は木に残り、画像は元の URL で見える。
 */
export async function runAttemptJob(job: AttemptJob): Promise<void> {
  const isPoe = job.model.startsWith(POE_PREFIX);
  const budget = createBudget();
  const gate = createRateLimitGate();
  // 1本の総時間の締め切り。担当の実行そのものは15分で止められるので、
  // その手前で必ず結果を書けるようにする
  const controller = new AbortController();
  const deadline = setTimeout(
    () =>
      controller.abort(
        `上流が${Math.round(RETRY_ATTEMPT_DEADLINE_MS / 60_000)}分以内に応答を完了しなかったため打ち切りました`,
      ),
    RETRY_ATTEMPT_DEADLINE_MS,
  );
  const finish = (
    kind: "success" | "refused" | "transient" | "fatal",
    detail: string | null,
    waitMs: number | null = null,
  ) =>
    finishRetryAttempt({
      id: job.attemptId,
      kind,
      detail: detail ? detail.slice(0, 301) : null,
      waitMs,
      now: Date.now(),
    });

  try {
    const messages = await expandAttachments(job.messages);
    const r = await runAttempt(
      { ...job, assistantMessageId: job.statusId, retry: undefined },
      messages,
      budget.spend,
      gate,
      controller.signal,
    );
    if (r.kind === "success") {
      const id = await appendRetrySuccess({
        attemptId: job.attemptId,
        statusId: job.statusId,
        conversationId: job.conversationId,
        modelId: job.model,
        content: r.content,
        usageJson: r.usageJson,
      });
      await finish("success", null);
      try {
        const captured = await captureGeneratedImages(
          r.content,
          r.imageUrls,
          {
            messageId: id,
            conversationId: job.conversationId,
            prompt: promptOf({ ...job, assistantMessageId: job.statusId, retry: undefined }),
          },
          budget,
        );
        if (captured.content !== r.content) {
          await rewriteMessageContent(id, captured.content);
        }
      } catch (e) {
        console.error("[gen] 画像の取り込みに失敗しました", id, e);
      }
    } else if (r.kind === "refused") {
      await finish("refused", r.text);
      if (!isPoe) await recordRefusalUsage(job.model, r.usageJson);
    } else if (r.kind === "transient") {
      await finish("transient", r.reason, r.waitMs);
    } else {
      await finish("fatal", r.reason);
    }
  } catch (e) {
    await finish(
      "transient",
      `担当の実行が失敗しました: ${(e as Error).message}`,
    ).catch(() => {});
  } finally {
    clearTimeout(deadline);
  }
}
