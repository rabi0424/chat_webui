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
    const burst = job.slice(job.indexOf("let burst = 0;"));
    expect(burst.indexOf("await insertRetryAttempt(")).toBeLessThan(
      burst.indexOf("await spawnAttempt("),
    );
    expect(burst).toContain('kind: "transient"');
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
      success.indexOf('await finish("success", null)'),
    );
    expect(success.indexOf('await finish("success", null)')).toBeLessThan(
      success.indexOf("captureGeneratedImages("),
    );
    expect(success).toContain("画像の取り込みに失敗しました");
  });

  it("拒否の額を台帳へ載せ（OpenRouter）、不調は待ち時間を運ぶ", () => {
    expect(w).toContain("if (!isPoe) await recordRefusalUsage(job.model, r.usageJson)");
    expect(w).toContain('await finish("transient", r.reason, r.waitMs)');
    expect(w).toContain('await finish("fatal", r.reason)');
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
    expect(alarm.slice(attemptAt, attemptAt + 200)).toContain("await this.clearJob()");
  });

  it("司令役は続きがあれば途中経過を保存して次のアラームを入れる", () => {
    const alarm = worker.slice(worker.indexOf("override async alarm()"));
    expect(alarm).toContain("runRetryGenerationJob(job, job.retry, state)");
    expect(alarm).toContain("this.ctx.storage.put(STATE_KEY, outcome.state)");
    expect(alarm).toContain("setAlarm(Date.now() + NEXT_CHUNK_MS)");
  });

  it("単発の生成も、行が消えたら読むのをやめる", () => {
    const single = fn(gen, "runSingleGeneration");
    const write = single.match(/const write = async[\s\S]*?\n {2}};/)![0];
    expect(write).toContain("!applied");
  });
});
