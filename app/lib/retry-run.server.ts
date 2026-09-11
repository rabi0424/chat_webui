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
import { fetchPoeRunPoints, type ChatMessage } from "./openrouter.server";
import { bareModelName, providerOf } from "./constants";
import type { ParamsState } from "./params";
import {
  RETRY_ALARM_WALL_MS,
  RETRY_ATTEMPT_DEADLINE_MS,
  RETRY_LIMIT_CHECK_INTERVAL_MS,
  RETRY_MAX_SPAWNS_PER_TICK,
  RETRY_STALLED_CHUNK_LIMIT,
  RETRY_TICK_FAILURE_LIMIT,
  RETRY_WORKER_LAUNCH_WINDOW_MS,
  RETRY_FREE_DO_SECONDS_PER_DAY,
  retryWorkerPlan,
  utcDayStart,
  afterAttemptSettled,
  createChunkBudget,
  createDurableShare,
  shouldLaunchWave,
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
  pruneOldRetryRun,
  dailyDurableMs,
  failRetryAttempts,
  finalizeGeneration,
  finishRetryAttempt,
  insertRetryAttempts,
  markRetryAttemptsProcessed,
  noteCoordinatorMs,
  retryRunCoordinatorMs,
  retryRunDurations,
  retryRunHeaderTimes,
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
  type OutgoingMessage,
} from "./generation.server";

/** 1本担当の実行へ渡す仕事。 */
export interface AttemptJob {
  kind: "attempt";
  /**
   * この担当が引き受けた依頼。1つの実行体の中で
   * `RETRY_WORKER_CONCURRENCY` 本ずつ同時に投げる——実行体を分けると
   * 待ち時間が並列数だけ倍に課金されるため（`RETRY_WORKER_ATTEMPTS`）。
   */
  attemptIds: string[];
  statusId: string;
  conversationId: string;
  model: string;
  web: boolean;
  webTools?: boolean;
  imageOutput?: boolean;
  /** 担当1つが同時に投げる本数の上書き（0/未指定で自動）。 */
  workerConcurrency?: number;
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
async function spawnAttempt(
  job: GenerationJob,
  attemptIds: string[],
): Promise<void> {
  const attempt: AttemptJob = {
    kind: "attempt",
    attemptIds,
    statusId: job.assistantMessageId,
    conversationId: job.conversationId,
    model: job.model,
    web: job.web,
    webTools: job.webTools,
    imageOutput: job.imageOutput,
    workerConcurrency: job.workerConcurrency,
    paramsState: job.paramsState,
    messages: job.messages,
  };
  const stub = env.GENERATOR.get(env.GENERATOR.idFromName(attemptIds[0]));
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
  const isPoe = providerOf(job.model) === "poe";
  const modelName = bareModelName(job.model);
  const statusId = job.assistantMessageId;
  const state: RetryRunState = { ...initialState(), ...(previous ?? {}) };
  const requestCap = retryRequestCap(retry.maxAttempts);
  /** 担当1つの持ち分。上流によって同時に投げられる数が違う。 */
  const plan = retryWorkerPlan(job.model, job.workerConcurrency);
  const chunkStartedAt = Date.now();
  /**
   * この続きの実行で使った内部サービス（D1）と担当の起こし。使い切ると
   * 見出しの打ち直しも通らなくなり、実行が黙って終わる
   * （`RETRY_CHUNK_INTERNAL_LIMIT` の注記）。手前で区切る。
   */
  const budget = createChunkBudget();

  let stopped = false;
  /** 見出しの行がもうこの実行のものではない（消えた・確定済み）。 */
  let lost = false;
  let touchFailed = false;
  let budgetStopped = false;
  /** 1日の実行体の時間の上限に達した。 */
  let doBudgetStopped = false;
  let running = 0;
  let ticks = 0;
  /** 続けて失敗した往復の数。続くなら区切って次のアラームへ渡す。 */
  let tickFailures = 0;
  let progressed = false;

  // 実行の記録（無ければ作る）と、続きの実行の頭の数え直し。
  // 数え上げは D1 が本体。担当が書いた行を集計し、集計に含めた行は
  // 「数えた」にして、この後の毎秒の読みで二重に数えない
  budget.spend(2);
  await createRetryRun({ statusId, conversationId: job.conversationId, now: state.startedAt });
  /*
   * 実行が始まるたびに、古い記録を1つぶんだけ片付ける。1日1万本なら
   * 1年で365万行になり、誰も見ない行で D1 の枠（5GB）が埋まる。
   * 掃除できなくても実行は続ける（本題ではない）。
   */
  budget.spend(3);
  await pruneOldRetryRun(Date.now()).catch(() => {});
  const snapshot = await retryRunSnapshot(statusId);
  state.successes = snapshot.counts.success;
  state.refusals = snapshot.counts.refused;
  state.attempts = snapshot.counts.success + snapshot.counts.refused;
  state.transients = snapshot.counts.transient;
  state.launched = snapshot.launched;
  state.lastSeq = snapshot.lastSeq;
  state.firstRefusal = state.firstRefusal ?? snapshot.firstRefusal;
  if (snapshot.counts.fatal > 0) state.fatal = true;
  // 開始時刻は記録が持つ。アラームが再送されて途中経過が無いまま再入
  // したときも、Poe の消費を同じ時間帯で数えられる
  if (snapshot.startedAt != null) state.startedAt = snapshot.startedAt;
  // 空の応答と拒否文は集計では分けられない（detail の有無で分ける）ので、
  // 続きの実行では refusals にまとめて数える

  // Poe: 続きの実行では、ここまでの消費を月間上限の判定に足せるよう取る
  if (isPoe && state.attempts > 0) {
    const soFar = await fetchPoeRunPoints(modelName, state.startedAt);
    if (soFar) {
      state.provisional = { points: soFar.points, costUsd: soFar.costUsd ?? null };
    }
  }

  /**
   * 今月の使用額が上限に達しているか。判定は D1 を3件ほど使うので、
   * 間隔を空けて見る（`RETRY_LIMIT_CHECK_INTERVAL_MS`）。毎周見ていた
   * ときは、それだけで内部サービスの枠の半分を使っていた。
   */
  let limitCheckedAt = 0;
  let limitBlocked = false;
  const overBudget = async (): Promise<boolean> => {
    if (limitBlocked) return true;
    if (Date.now() - limitCheckedAt < RETRY_LIMIT_CHECK_INTERVAL_MS) return false;
    limitCheckedAt = Date.now();
    try {
      budget.spend(3);
      limitBlocked = (await checkMonthlyLimit(Date.now(), state.provisional))
        .blocked;
      return limitBlocked;
    } catch {
      // 判定できないことを理由に、走っている生成を止めはしない
      return false;
    }
  };

  /**
   * 1日に使ってよい「実行体が起きている時間」を超えたか。
   *
   * 無料枠を使い切ると**どの生成も始められなくなり、翌0時（UTC）まで
   * 戻らない**。上流の課金と違って台帳に載らないので、自分で数えて
   * 手前で止める。判定は D1 を1件使うので、月間上限と同じ間隔で見る。
   */
  let doCheckedAt = 0;
  const overDailyDoBudget = async (): Promise<boolean> => {
    const limit = job.dailyDoSecondsBudget ?? 0;
    if (!(limit > 0)) return false;
    // 一度あきらめたら、間隔を空けずにそのまま真を返す。ここを外すと
    // 30秒の間隔のあいだだけ判定が偽に戻り、走っている担当を待つ往復で
    // 新しい担当を起こしてしまう
    if (doBudgetStopped) return true;
    if (Date.now() - doCheckedAt < RETRY_LIMIT_CHECK_INTERVAL_MS) return false;
    doCheckedAt = Date.now();
    try {
      budget.spend();
      const usedMs = await dailyDurableMs(utcDayStart(Date.now()));
      if (usedMs / 1000 >= limit) {
        doBudgetStopped = true;
        state.lastError =
          `1日の実行体の時間の上限（${limit.toLocaleString()}秒）に達したため打ち切りました。` +
          `UTCの0時に戻ります`;
        return true;
      }
      return false;
    } catch {
      // 数えられないことを理由に、走っている生成を止めはしない
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
      budget.spend();
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
      tickFailures = 0;
      if (t.stopRequested) stopped = true;
      if (!t.applied) {
        // 行が消えたか確定済み。会話を消しても投げ続けないよう停止と同じに扱う
        lost = true;
        stopped = true;
      }
      running = t.running;
      if (t.finished.length > 0) {
        for (const row of t.finished) absorb(row);
        budget.spend();
        await markRetryAttemptsProcessed(t.finished.map((r) => r.id));
      }
    } catch (e) {
      touchFailed = true;
      tickFailures++;
      console.error("[gen] 司令役の生存確認を書けませんでした", statusId, e);
    }
  };

  /** 担当の実行が失われた行を決着させる。 */
  const sweep = async (): Promise<void> => {
    try {
      budget.spend();
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
      !stopped &&
      !lost &&
      !touchFailed &&
      !state.fatal &&
      !budgetStopped;
    const wantMore =
      state.successes < retry.target &&
      state.attempts + running < retry.maxAttempts &&
      state.launched < requestCap;

    // 目標に届くまで、上限と並列数の範囲で担当を起こし続ける
    if (canLaunch && wantMore && Date.now() >= waitUntil()) {
      // 日の枠の判定を先に置く。一度あきらめたあとは即座に真を返すので、
      // 走っている担当を待つあいだ月間上限の問い合わせ（D1 を3件）を
      // 繰り返さずに済む
      if (await overDailyDoBudget()) {
        // 打ち切る理由は overDailyDoBudget が lastError に書く
      } else if (await overBudget()) {
        state.lastError = "今月の使用額が上限に達したため打ち切りました";
        budgetStopped = true;
      } else if (
        /*
         * 空きが少ないうちは起こさない。1本ずつ起こすと、その1本が生成
         * 時間まるごとを実行体の時間として負う——依頼ごとに実行体を
         * 分けるのと同じで、禁じているはずの形に戻る（`shouldLaunchWave`）。
         */
        shouldLaunchWave({
          room: Math.min(
            slots() - running,
            retry.maxAttempts - state.attempts - running,
            requestCap - state.launched,
          ),
          running,
          slots: slots(),
        })
      ) {
        /*
         * この往復で起こす分を決める。担当1つに依頼を
         * `RETRY_WORKER_ATTEMPTS` 本まとめて持たせる——実行体を分けると
         * 待ち時間が並列数だけ倍に課金されるため（retry.ts の注記）。
         * 1回の往復で起こす担当の数は区切る（起こしているあいだ見出しを
         * 打ち直せないため）。枠の残りぶんしか作らない
         * （行の作成1件＋担当ごとに1件）。
         */
        const groups: { id: string; seq: number }[][] = [];
        let planned = 0;
        const roomForMore = () =>
          running + planned < slots() &&
          state.attempts + running + planned < retry.maxAttempts &&
          state.launched + planned < requestCap;
        while (
          groups.length < RETRY_MAX_SPAWNS_PER_TICK &&
          roomForMore() &&
          budget.room(groups.length + 2)
        ) {
          const group: { id: string; seq: number }[] = [];
          while (group.length < plan.attempts && roomForMore()) {
            group.push({
              id: crypto.randomUUID(),
              seq: state.lastSeq + planned + 1,
            });
            planned++;
          }
          if (group.length === 0) break;
          groups.push(group);
        }
        const batch = groups.flat();
        if (batch.length > 0) {
          let inserted = false;
          try {
            // 行を先に作る。担当の実行が失われても行は残り、掃除で決着する
            budget.spend();
            await insertRetryAttempts({ statusId, attempts: batch, now: Date.now() });
            state.lastSeq = batch[batch.length - 1].seq;
            inserted = true;
          } catch (e) {
            state.lastError = `担当の行を作れませんでした: ${(e as Error).message}`;
          }
          for (let i = 0; inserted && i < groups.length; i++) {
            // 停止要求は起こす直前に見る。起こしてから気づいたのでは、
            // 押したあとに1本ぶん余計に投げて課金されてしまう
            if (stopped || !budget.room(1)) {
              await failRetryAttempts({
                ids: groups.slice(i).flat().map((b) => b.id),
                detail: stopped ? "停止のため起こしませんでした" : "枠の切れ目で起こしませんでした",
                now: Date.now(),
              }).catch(() => {});
              break;
            }
            if (i > 0) await sleep(SPAWN_STAGGER_MS);
            try {
              budget.spend();
              await spawnAttempt(job, groups[i].map((b) => b.id));
              state.launched += groups[i].length;
              running += groups[i].length;
              progressed = true;
            } catch (e) {
              // 起こせなかった分は不調として決着させ、待ってから投げ直す
              await failRetryAttempts({
                ids: groups.slice(i).flat().map((b) => b.id),
                detail: `担当の実行を起こせませんでした: ${(e as Error).message}`,
                now: Date.now(),
              }).catch(() => {});
              break;
            }
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
      doBudgetStopped ||
      state.successes >= retry.target ||
      state.attempts >= retry.maxAttempts ||
      state.launched >= requestCap;
    if (finishedLaunching && running === 0) break;

    /*
     * 続きの実行の区切り。走っている依頼は担当が持っているので失われない。
     * 内部サービスの枠を使い切る手前で区切るのが要（使い切ると見出しの
     * 打ち直しも通らなくなり、60秒の無更新で中断とみなされて黙って
     * 終わる）。往復が続けて失敗しているときも、次のアラームで枠を
     * 取り直したほうが早い。
     */
    if (
      !budget.ok() ||
      tickFailures >= RETRY_TICK_FAILURE_LIMIT ||
      Date.now() - chunkStartedAt > COORDINATOR_CHUNK_MS
    ) {
      state.stalledChunks = progressed ? 0 : state.stalledChunks + 1;
      if (state.stalledChunks >= RETRY_STALLED_CHUNK_LIMIT) {
        state.lastError = `進まないまま${state.stalledChunks}回続いたため打ち切りました${
          touchFailed ? "（進捗を保存できませんでした）" : ""
        }`;
        break;
      }
      if (lost) break;
      // 司令役が起きていた時間も無料枠を食う。数えておかないと
      // 歯止めが担当のぶんしか見ない
      await noteCoordinatorMs(statusId, Date.now() - chunkStartedAt).catch(
        () => {},
      );
      console.log(
        `[gen] retry chunk paused: internal=${budget.spent()} attempts=${state.attempts} successes=${state.successes} running=${running} launched=${state.launched} tickFailures=${tickFailures}`,
      );
      return { done: false, state };
    }

    await sleep(ticks < TICK_FAST_COUNT ? TICK_MS : TICK_SLOW_MS);
  }

  await noteCoordinatorMs(statusId, Date.now() - chunkStartedAt).catch(() => {});

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
  const cutShort =
    budgetStopped ||
    doBudgetStopped ||
    state.fatal ||
    requestsExhausted ||
    stalled;
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
  } else if (doBudgetStopped) {
    lines.push(
      "1日に使ってよい実行体の時間の上限に達しました。UTCの0時（日本時間の朝9時）に戻ります。",
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
  /*
   * 実測。依頼1本あたりの実行体の時間は「かかった時間 ÷ 担当1つの
   * 同時数」で、それがそのまま無料枠（1日 13,000 GB秒＝128MB 換算で
   * 約104,000秒）の消費になる。同時数をいくつにすべきかを、憶測では
   * なくここの数字から決められるようにする。
   */
  try {
    const d = await retryRunDurations(statusId);
    if (d.count > 0) {
      const perAttempt = d.totalMs / d.count / 1000;
      // 担当が書いた取り分の合計をそのまま出す（歯止めが数えているのと
      // 同じ数字）。古い行には取り分が無いので、そのときだけ割って作る
      const workerSeconds =
        d.doMs > 0 ? d.doMs / 1000 : d.totalMs / 1000 / plan.concurrency;
      /*
       * 司令役のぶんも足して出す。**歯止めはこの合計で数えている**ので、
       * 担当のぶんだけ見せると枠の半分近くが見えないまま消える。司令役は
       * 実行のあいだずっと起きているので、割合はおよそ 12 ÷ 並列数——
       * 並列数を上げるほど、担当のぶんに対して薄まる。
       */
      const coordinatorSeconds = (await retryRunCoordinatorMs(statusId)) / 1000;
      const doSeconds = workerSeconds + coordinatorSeconds;
      const share = (doSeconds / RETRY_FREE_DO_SECONDS_PER_DAY) * 100;
      /*
       * 実効の同時数＝かかった時間の合計 ÷ 実行体の時間。**本当に何本
       * 重なっていたか**がそのまま出るので、ヘッダまでの時間より直に
       * 「同時数が効いているか」を答える。設定が24でも実効が6なら、
       * どこかで順番待ちしている。
       */
      const effective = d.doMs > 0 ? d.totalMs / d.doMs : null;
      lines.push(
        `\n1本あたり ${perAttempt.toFixed(1)}秒（同時 ${plan.concurrency}本` +
          `${effective ? `・実効 ${effective.toFixed(1)}本` : ""}）` +
          `・実行体の時間 ${Math.round(doSeconds).toLocaleString()}秒` +
          `（担当 ${Math.round(workerSeconds).toLocaleString()}秒＋司令役 ${Math.round(coordinatorSeconds).toLocaleString()}秒）` +
          `＝1日の無料枠の ${share.toFixed(1)}%`,
      );
    }
    /*
     * 応答ヘッダが返るまでの時間。**本当に同時に投げられているか**は
     * これで分かる。かかった時間だけでは、順番待ちで遅いのか生成が
     * 遅いのかを区別できない（拒否が速いプロンプトかどうかで変わる）。
     * 最長がほぼ1本ぶんの生成時間なら、7本目以降が順番待ちしている。
     */
    const h = await retryRunHeaderTimes(statusId);
    if (h.count > 0) {
      lines.push(
        `ヘッダまで 平均 ${(h.avgMs / 1000).toFixed(1)}秒・` +
          `最長 ${(h.maxMs / 1000).toFixed(1)}秒` +
          `（最長が生成1本ぶんに近ければ、同時数が実際には効いていません）`,
      );
    }
  } catch {
    // 実測が取れなくても要約は出す
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

  budget.spend(2);
  console.log(
    `[gen] retry run finished: internal=${budget.spent()} attempts=${state.attempts} successes=${state.successes} refusals=${state.refusals} empty=${state.emptyResponses} transients=${state.transients} launched=${state.launched}`,
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
/**
 * 1本担当。引き受けた依頼を、1つの実行体の中で
 * `RETRY_WORKER_CONCURRENCY` 本ずつ同時に投げ、結果を D1 に書く。
 *
 * **例外を外へ出さない**——出すとアラームが再送され、同じ依頼をもう一度
 * 投げて二重に課金される。結果を書けなかった行は、司令役が時間切れで
 * 一時的な不調として掃く。
 *
 * 成功は保存できた時点で書く（親の付け替えは1つの batch で原子的）。
 * 画像の取り込みで失敗しても行は木に残り、画像は元の URL で見える。
 */
export async function runAttemptJob(job: AttemptJob): Promise<void> {
  // Poe だけは応答にも拒否文にも額が載らず、実行の最後にまとめて
  // 突き合わせる。他の窓口は1本ごとに台帳へ載せる
  const isPoe = providerOf(job.model) === "poe";
  const plan = retryWorkerPlan(job.model, job.workerConcurrency);
  // 外部の通信の枠（1回の呼び出しで50件）は担当の中で共有する。
  // 成功すると画像の取り込みにも使うので、投げる側は手前で切り上げる
  const budget = createBudget();
  const gate = createRateLimitGate();
  const startedAt = Date.now();
  const queue = [...job.attemptIds];
  const inner = { ...job, assistantMessageId: job.statusId, retry: undefined };

  const finish = (
    attemptId: string,
    kind: "success" | "refused" | "transient" | "fatal",
    detail: string | null,
    waitMs: number | null = null,
    headerMs: number | null = null,
    doMs: number | null = null,
  ) =>
    finishRetryAttempt({
      id: attemptId,
      kind,
      detail: detail ? detail.slice(0, 301) : null,
      waitMs,
      headerMs,
      doMs,
      now: Date.now(),
    });

  /** 引き受けたが投げられなかった分。待ち続けさせないので必ず決着させる。 */
  const giveUp = async (ids: string[], detail: string): Promise<void> => {
    if (ids.length === 0) return;
    await failRetryAttempts({ ids, detail, now: Date.now() }).catch(() => {});
  };

  let messages: OutgoingMessage[];
  try {
    messages = await expandAttachments(job.messages);
  } catch (e) {
    await giveUp(queue, `添付の読み出しに失敗しました: ${(e as Error).message}`);
    return;
  }

  /**
   * 依頼1本ぶんの「実行体が起きている時間」の取り分（`createDurableShare`）。
   * 無料枠の消費はこれで数える。
   */
  const share = createDurableShare();

  const runOne = async (attemptId: string): Promise<void> => {
    share.begin(attemptId);
    /** この依頼の取り分。結果を書くときに1度だけ呼ぶ。 */
    const doMs = () => share.end(attemptId);
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
    // 応答ヘッダが返るまでの時間。同時に投げられているかの物差しで、
    // かかった時間と違ってプロンプトの当たり外れに左右されない
    const timing: { headerMs?: number } = {};
    try {
      const r = await runAttempt(
        inner,
        messages,
        budget.spend,
        gate,
        controller.signal,
        timing,
      );
      if (r.kind === "success") {
        const id = await appendRetrySuccess({
          attemptId,
          statusId: job.statusId,
          conversationId: job.conversationId,
          modelId: job.model,
          content: r.content,
          usageJson: r.usageJson,
        });
        await finish(attemptId, "success", null, null, timing.headerMs ?? null, doMs());
        try {
          const captured = await captureGeneratedImages(
            r.content,
            r.imageUrls,
            {
              messageId: id,
              conversationId: job.conversationId,
              prompt: promptOf(inner),
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
        await finish(attemptId, "refused", r.text, null, timing.headerMs ?? null, doMs());
        if (!isPoe) await recordRefusalUsage(job.model, r.usageJson);
      } else if (r.kind === "transient") {
        await finish(attemptId, "transient", r.reason, r.waitMs, timing.headerMs ?? null, doMs());
      } else {
        await finish(attemptId, "fatal", r.reason, null, timing.headerMs ?? null, doMs());
      }
    } catch (e) {
      await finish(
        attemptId,
        "transient",
        `担当の実行が失敗しました: ${(e as Error).message}`,
        null,
        null,
        doMs(),
      ).catch(() => {});
    } finally {
      clearTimeout(deadline);
    }
  };

  /** 新しく投げてよいか。窓を過ぎたら、残りは決着させて次の担当へ渡す。 */
  const canStart = () =>
    Date.now() - startedAt < RETRY_WORKER_LAUNCH_WINDOW_MS && budget.canLaunch();

  const inflight = new Set<Promise<void>>();
  while (queue.length > 0 && canStart()) {
    while (
      inflight.size < plan.concurrency &&
      queue.length > 0 &&
      canStart()
    ) {
      // 同時に投げる分も少しずらす（上流へ一斉に当たるのを避ける）
      if (inflight.size > 0) await sleep(SPAWN_STAGGER_MS);
      const attemptId = queue.shift()!;
      const p = runOne(attemptId).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (inflight.size === 0) break;
    await Promise.race(inflight);
  }
  await Promise.all(inflight);
  await giveUp(
    queue,
    budget.canLaunch()
      ? "担当の持ち時間が尽きました"
      : "担当の通信の枠が尽きました",
  );
}
