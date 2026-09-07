import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 「成功するまで生成」の配線。司令役（retry-run.server.ts）と1本担当、
 * その下の runAttempt（generation.server.ts）、DO の振り分け（workers/app.ts）。
 *
 * 実行体そのものを回すには上流・D1・R2・DO の全部を差し替える必要が
 * あり、ここでは配線だけを見る（file-deletion-wiring.test.ts と同じ形）。
 * 判定の構造を変えるときは、このテストも「新しい構造で同じ漏れが
 * 起きないか」を見る形へ書き換えること。
 */
const run = readFileSync("app/lib/retry-run.server.ts", "utf8");
const gen = readFileSync("app/lib/generation.server.ts", "utf8");
const worker = readFileSync("workers/app.ts", "utf8");

/** 関数の本文を、名前から次のトップレベル定義まで切り出す。 */
function fn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function |\n\/\/ ---/);
  return rest.slice(0, end < 0 ? undefined : end);
}

describe("司令役の続行判定", () => {
  const job = fn(run, "runRetryGenerationJob");

  it("起こすのをやめる理由が全部入っている", () => {
    const can = job.match(/const canLaunch =[\s\S]*?;/)![0];
    expect(can).toContain("!stopped");
    expect(can).toContain("!lost");
    expect(can).toContain("!touchFailed");
    expect(can).toContain("!state.fatal");
    expect(can).toContain("!budgetStopped");
    const finished = job.match(/const finishedLaunching =[\s\S]*?;/)![0];
    for (const reason of [
      "stopped",
      "lost",
      "state.fatal",
      "budgetStopped",
      "state.successes >= retry.target",
      "state.attempts >= retry.maxAttempts",
      "state.launched >= requestCap",
    ]) {
      expect(finished).toContain(reason);
    }
    // 一時的な不調の連続は理由に無い（何回続いても打ち切らない）
    expect(run).not.toContain("transientExhausted");
    expect(run).not.toContain("consecutiveErrors");
  });

  it("走っている担当が残っているあいだは終えない（課金済み）", () => {
    expect(job).toContain("if (finishedLaunching && running === 0) break;");
  });

  it("毎秒の1往復は例外を外へ出さず、行を失ったら起こさない", () => {
    const tick = job.match(/const tick = async[\s\S]*?\n {2}};/)![0];
    expect(tick).toContain("catch (e)");
    expect(tick).toContain("touchFailed = true");
    expect(tick).toContain("if (!t.applied)");
    expect(tick).toContain("lost = true");
    expect(tick).toContain("stopped = true");
    // 決まった行は数えてから印を付ける
    expect(tick).toContain("absorb(row)");
    expect(tick).toContain("markRetryAttemptsProcessed(");
  });

  it("見出しを失ったら確定も要約も書かない", () => {
    const after = job.slice(job.indexOf("if (finishedLaunching && running === 0) break;"));
    const lostAt = after.indexOf("if (lost)");
    expect(lostAt).toBeGreaterThan(-1);
    expect(lostAt).toBeLessThan(after.indexOf("fetchPoeRunPoints"));
    expect(lostAt).toBeLessThan(after.indexOf("finalizeGeneration("));
  });

  it("担当を起こす前に行を作り、起こせなければ不調として決着させる", () => {
    const burst = job.slice(
      job.indexOf("const groups: { id: string; seq: number }[][] = []"),
    );
    // 行が先。逆にすると、担当が結果を書きに来ても書く先が無い
    expect(burst.indexOf("await insertRetryAttempts(")).toBeLessThan(
      burst.indexOf("await spawnAttempt("),
    );
    expect(burst).toContain("failRetryAttempts({");
    expect(burst).toContain("担当の実行を起こせませんでした");
  });

  it("結果の数え方: 成功と拒否は試行、不調は待ち、直らないは止める", () => {
    const absorb = job.match(/const absorb = \(row: RetryAttemptRow\) => \{[\s\S]*?\n {2}};/)![0];
    const success = absorb.slice(absorb.indexOf('row.kind === "success"'), absorb.indexOf('row.kind === "refused"'));
    expect(success).toContain("state.successes++");
    expect(success).toContain("state.attempts++");
    const refused = absorb.slice(absorb.indexOf('row.kind === "refused"'), absorb.indexOf('row.kind === "transient"'));
    expect(refused).toContain("state.attempts++");
    const transient = absorb.slice(absorb.indexOf('row.kind === "transient"'), absorb.indexOf('row.kind === "fatal"'));
    expect(transient).not.toContain("state.attempts++");
    expect(transient).toContain("onTransientFailure(");
    const fatal = absorb.slice(absorb.indexOf('row.kind === "fatal"'));
    expect(fatal).toContain("state.fatal = true");
  });

  it("続きの実行の頭で D1 から数え直し、進まないチャンクは3回で終える", () => {
    expect(job).toContain("await retryRunSnapshot(statusId)");
    expect(job).toContain("state.stalledChunks = progressed ? 0 : state.stalledChunks + 1");
    expect(job).toContain("state.stalledChunks >= RETRY_STALLED_CHUNK_LIMIT");
    // 失われた担当の掃除
    expect(job).toContain("sweepLostRetryAttempts(");
  });

  it("毎秒の間隔は刻んだ回数が積もったら広げる", () => {
    expect(job).toContain("ticks < TICK_FAST_COUNT ? TICK_MS : TICK_SLOW_MS");
  });
});

/**
 * 内部サービス（D1）の枠。無料プランは1回の呼び出しにつき1,000件で、
 * 使い切ると見出しの打ち直しも通らなくなり、60秒の無更新で中断と
 * みなされて実行が黙って終わる（実際に並列100で起きた）。数え漏らすと
 * 同じことが起きるので、呼ぶ場所ごとに数えているかを見張る。
 */
describe("枠の勘定", () => {
  const job = fn(run, "runRetryGenerationJob");

  it("D1 と担当の起こしを、呼ぶ場所ごとに数える", () => {
    const tick = job.match(/const tick = async[\s\S]*?\n {2}};/)![0];
    expect(tick.indexOf("budget.spend()")).toBeLessThan(
      tick.indexOf("await tickRetryRun("),
    );
    expect(tick).toContain("budget.spend();\n        await markRetryAttemptsProcessed(");
    const sweep = job.match(/const sweep = async[\s\S]*?\n {2}};/)![0];
    expect(sweep.indexOf("budget.spend()")).toBeLessThan(
      sweep.indexOf("await sweepLostRetryAttempts("),
    );
    const burst = job.slice(job.indexOf("const groups: { id: string; seq: number }[][] = []"));
    expect(burst).toContain("budget.spend();\n            await insertRetryAttempts(");
    expect(burst).toContain("budget.spend();\n              await spawnAttempt(");
    // 実行の頭（記録の作成と数え直し）と、最後の確定
    expect(job).toContain("budget.spend(2);\n  await createRetryRun(");
    expect(job).toContain("budget.spend(2);\n  console.log(");
  });

  it("枠を使い切る手前で区切り、次のアラームへ渡す", () => {
    const end = job.match(/if \(\n {6}!budget\.ok\(\) \|\|[\s\S]*?\) \{/)![0];
    expect(end).toContain("!budget.ok()");
    expect(end).toContain("tickFailures >= RETRY_TICK_FAILURE_LIMIT");
    expect(end).toContain("COORDINATOR_CHUNK_MS");
    // 区切りは終わりの判定より後（走っている担当があれば渡す）
    expect(job.indexOf("if (finishedLaunching && running === 0) break;")).toBeLessThan(
      job.indexOf("!budget.ok()"),
    );
  });

  it("1回の往復で起こす担当の数と、枠の残りで区切る", () => {
    const burst = job.slice(job.indexOf("const groups: { id: string; seq: number }[][] = []"));
    const cond = burst.slice(0, burst.indexOf("const group:"));
    expect(cond).toContain("groups.length < RETRY_MAX_SPAWNS_PER_TICK");
    expect(cond).toContain("budget.room(groups.length + 2)");
    // 担当1つは依頼をまとめて引き受ける（実行体を分けると課金が倍になる）。
    // 何本まとめるかは上流で違う（ヘッダがすぐ返るなら同時数を増やせる）
    expect(burst).toContain("group.length < plan.attempts");
    expect(job).toContain("retryWorkerPlan(job.model)");
    // 作ったが起こさなかった行は、まとめて不調として決着させる
    expect(burst).toContain("failRetryAttempts({");
    expect(burst).toContain("if (stopped || !budget.room(1))");
  });

  it("月間上限の判定は間隔を空ける（毎周だと枠の半分を使う）", () => {
    const over = job.match(/const overBudget = async[\s\S]*?\n {2}};/)![0];
    expect(over).toContain("RETRY_LIMIT_CHECK_INTERVAL_MS");
    expect(over).toContain("limitCheckedAt = Date.now()");
    expect(over).toContain("budget.spend(3)");
    // 一度上限に達したら、以後は聞き直さない
    expect(over).toContain("if (limitBlocked) return true");
  });
});

describe("1本担当", () => {
  const w = fn(run, "runAttemptJob");

  it("例外を外へ出さず、必ず結果を書く", () => {
    expect(w).toContain("try {");
    expect(w).toContain("} catch (e) {");
    const caught = w.slice(w.indexOf("} catch (e) {"));
    expect(caught).toContain('"transient"');
    expect(caught).toContain("担当の実行が失敗しました");
    expect(w).toContain("finally {");
  });

  it("成功は保存できた時点で書き、画像の取り込みの失敗で取り消さない", () => {
    const success = w.slice(w.indexOf('if (r.kind === "success")'), w.indexOf('else if (r.kind === "refused")'));
    expect(success.indexOf("await appendRetrySuccess(")).toBeLessThan(
      success.indexOf('await finish(attemptId, "success", null)'),
    );
    expect(success.indexOf('await finish(attemptId, "success", null)')).toBeLessThan(
      success.indexOf("captureGeneratedImages("),
    );
    expect(success).toContain("画像の取り込みに失敗しました");
  });

  it("引き受けた依頼を、同時数を守って回し、投げなかった分は決着させる", () => {
    expect(w).toContain("inflight.size < plan.concurrency");
    expect(w).toContain("retryWorkerPlan(job.model)");
    expect(w).toContain("await Promise.race(inflight)");
    expect(w).toContain("await Promise.all(inflight)");
    // 窓を過ぎたら新しく投げない。引き受けたまま放置しない
    expect(w).toContain("RETRY_WORKER_LAUNCH_WINDOW_MS");
    expect(w).toContain("budget.canLaunch()");
    const tail = w.slice(w.indexOf("await Promise.all(inflight)"));
    expect(tail).toContain("await giveUp(");
  });

  it("拒否の額を台帳へ載せ（OpenRouter）、不調は待ち時間を運ぶ", () => {
    expect(w).toContain("if (!isPoe) await recordRefusalUsage(job.model, r.usageJson)");
    expect(w).toContain('await finish(attemptId, "transient", r.reason, r.waitMs)');
    expect(w).toContain('await finish(attemptId, "fatal", r.reason)');
  });

  it("1本の締め切りを signal で渡す", () => {
    expect(w).toContain("new AbortController()");
    expect(w).toContain("RETRY_ATTEMPT_DEADLINE_MS");
    expect(w).toContain("controller.signal");
    expect(w).toContain("clearTimeout(deadline)");
  });
});

describe("runAttempt（上流1本）", () => {
  const attempt = fn(gen, "runAttempt");

  it("失敗の分け方は upstream-outcome に一本化し、HTTP のエラーも本文の中のエラーも通す", () => {
    const http = attempt.slice(attempt.indexOf("if (!upstream.ok || !upstream.body)"));
    expect(http).toContain("classifyUpstreamFailure({");
    expect(http).toContain("status: upstream.status");
    expect(http).toContain("upstreamErrorMessage(upstream, isPoe, body)");
    const mid = attempt.slice(attempt.indexOf("if (!hasImage && result.error)"));
    expect(mid).toContain("classifyUpstreamFailure({");
    expect(mid).toContain("status: result.error.code");
    expect(attempt).not.toContain("MODERATION");
  });

  it("画像を出すモデルは、ヘッダ待ちも本文の無音も締め切りまで待ち、signal を渡す", () => {
    expect(attempt).toMatch(
      /const idleTimeoutMs = job\.imageOutput\s*\?\s*RETRY_ATTEMPT_DEADLINE_MS\s*:\s*UPSTREAM_IDLE_TIMEOUT_MS/,
    );
    expect(attempt).toContain("connectTimeoutMs: idleTimeoutMs,");
    const req = attempt.slice(attempt.indexOf("requestUpstream(job, messages, onRequest, {"));
    expect(req.slice(0, req.indexOf("})"))).toContain("signal,");
  });
});

describe("DO の振り分けと単発の生成", () => {
  it("1本担当の仕事は見出しの状態を見ずに走り、アラームの再送を招かない", () => {
    const alarm = worker.slice(worker.indexOf("override async alarm()"));
    const attemptAt = alarm.indexOf("await runAttemptJob(job)");
    expect(attemptAt).toBeGreaterThan(-1);
    expect(attemptAt).toBeLessThan(alarm.indexOf("await getMessage("));
    // 担当は使い捨て。置き場を丸ごと空にする（依頼文の写しが積もると
    // アカウント全体のストレージを食い、どの生成も始められなくなる）
    expect(alarm.slice(attemptAt, attemptAt + 300)).toContain(
      "await this.ctx.storage.deleteAll()",
    );
  });

  it("ジョブを受け取れなければ、理由を返す（例外のまま外へ出さない）", () => {
    const fetchBody = worker.slice(
      worker.indexOf("override async fetch(request: Request)"),
    );
    const body = fetchBody.slice(0, fetchBody.indexOf("\n  override async alarm"));
    expect(body).toContain("try {");
    expect(body).toContain("} catch (e) {");
    expect(body).toContain("status: 500");
    expect(body).toContain("error: reason");
  });

  it("「成功するまで生成」は、途中経過が無いアラームでも確定させず再入する", () => {
    const alarm = worker.slice(worker.indexOf("override async alarm()"));
    // 旧方式の番人（!state && content !== ""）は、いまは生きている実行を殺す
    expect(alarm).not.toContain('!state && row.content !== ""');
    expect(alarm).toContain("shouldFinalizeLostRun({");
    expect(alarm).toContain("retry: job.retry != null");
    expect(alarm).toContain("hasState: state != null");
  });

  it("司令役は続きがあれば途中経過を保存して次のアラームを入れる", () => {
    const alarm = worker.slice(worker.indexOf("override async alarm()"));
    expect(alarm).toContain("runRetryGenerationJob(job, job.retry, state)");
    expect(alarm).toContain("this.ctx.storage.put(STATE_KEY, outcome.state)");
    expect(alarm).toContain("setAlarm(Date.now() + NEXT_CHUNK_MS)");
  });

  it("中断の確定は、見出しなら本文ごと書き換える", () => {
    const db = readFileSync("app/lib/db.server.ts", "utf8");
    const sweep = db.slice(db.indexOf("async function sweepStaleStreaming("));
    const body = sweep.slice(0, sweep.indexOf("\n}"));
    expect(body).toContain("interruptedGenerationRow(m.content)");
    expect(body).toContain("m.content = next.content");
    // 本文を bind に載せないと、見出しの「生成中…」が残る
    expect(body).toContain(".bind(m.content, m.status, m.error, m.id)");
  });

  it("単発の生成も、行が消えたら読むのをやめる", () => {
    const single = fn(gen, "runSingleGeneration");
    const write = single.match(/const write = async[\s\S]*?\n {2}};/)![0];
    expect(write).toContain("!applied");
  });
});
