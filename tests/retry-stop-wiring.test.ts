import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * リトライ生成の発射ループの配線。
 *
 * 打ち切りの理由はローカル変数（stopped / transientExhausted /
 * fatalStopped / budgetStopped / requestsExhausted）に散っていて、続行判定（moreAttempts）
 * への追記を1つ忘れても画面には何も出ない。実際に budgetStopped が
 * 抜けていて、月間上限に達した実行が「枠切れで中断しただけ」と解釈され、
 * DO が 50ms 間隔でアラームを打ち直し続けた——毎周 R2 と D1 を読む無限
 * ループで、止める手立ては停止ボタンだけだった。
 *
 * 実行体そのものを回すには上流・D1・R2 の全部を差し替える必要があり、
 * ここでは配線だけを見る（file-deletion-wiring.test.ts と同じ形）。
 * 判定の構造を変えるときは、このテストも「新しい構造で同じ漏れが
 * 起きないか」を見る形へ書き換えること。
 */
const source = readFileSync("app/lib/generation.server.ts", "utf8");

/** 関数の本文を、名前から次のトップレベル定義まで切り出す。 */
function fn(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function |\n\/\/ ---/);
  return rest.slice(0, end < 0 ? undefined : end);
}

describe("リトライ生成の続行判定", () => {
  it("打ち切りの理由が5つとも続行判定に入っている", () => {
    const m = source.match(/const moreAttempts =[\s\S]*?;/);
    expect(m).not.toBeNull();
    const expr = m![0];
    expect(expr).toContain("!stopped");
    expect(expr).toContain("!transientExhausted");
    expect(expr).toContain("!fatalStopped");
    expect(expr).toContain("!budgetStopped");
    expect(expr).toContain("!requestsExhausted");
  });

  it("進まないチャンクが続いたら、続きを頼まずに終える", () => {
    const job = fn("runRetryGenerationJob");
    expect(job).toContain(
      "state.stalledChunks = progressed ? 0 : state.stalledChunks + 1",
    );
    expect(job).toContain(
      "const stalled = state.stalledChunks >= RETRY_STALLED_CHUNK_LIMIT",
    );
    expect(job).toContain(
      "if (!stalled && (moreAttempts || state.pendingCapture.length > 0))",
    );
    // 進捗は試行・待ち直し・持ち越した画像の取り込みのどれか
    const progressed = job.match(/const progressed =[\s\S]*?;/)![0];
    expect(progressed).toContain("state.attempts > atStart.attempts");
    expect(progressed).toContain("state.rateLimitRounds > atStart.rounds");
    expect(progressed).toContain("state.pendingCapture.length < atStart.pending");
  });
});

describe("上流への本数の柵", () => {
  const job = fn("runRetryGenerationJob");

  it("投げるたびに数え、発射の条件と続行判定の両方で見る", () => {
    // 数えるのは requestUpstream が実際に投げる直前（429 も、やり直しも）
    const launch = job.match(/const launch = \(\) => \{[\s\S]*?\n {2}};/)![0];
    expect(launch).toContain("state.upstreamRequests++");
    const loop = job.match(
      /\/\/ 目標に届くまで、上限と並列数の範囲で発射し続ける[\s\S]*?\{/,
    )![0];
    expect(loop).toContain("state.upstreamRequests < requestCap");
    expect(job).toContain(
      "const requestsExhausted = state.upstreamRequests >= requestCap",
    );
    expect(job).toContain("retryRequestCap(retry.maxAttempts)");
  });

  it("数はチャンクをまたいで持ち越す", () => {
    const restore = source.slice(source.indexOf("function restoreRetryState"));
    expect(restore.slice(0, restore.indexOf("\n}"))).toContain(
      "upstreamRequests: previous.upstreamRequests ?? 0",
    );
    expect(restore.slice(0, restore.indexOf("\n}"))).toContain(
      "stalledChunks: previous.stalledChunks ?? 0",
    );
  });
});

describe("受け取る先が無くなった実行", () => {
  const job = fn("runRetryGenerationJob");

  it("生存確認は例外を外へ出さず、書けなければ発射を止める", () => {
    const touch = job.match(/const touch = async[\s\S]*?\n {2}};/)![0];
    expect(touch).toContain("try {");
    expect(touch).toContain("catch (e)");
    expect(touch).toContain("touchFailed = true");
    // 保存が当たらない＝行が消えた・確定済み。停止と同じに扱う
    expect(touch).toContain("if (!applied)");
    expect(touch).toContain("lost = true");
    expect(touch).toContain("stopped = true");
  });

  it("発射の条件に、生存確認の失敗と同じ失敗の連続が入っている", () => {
    const loop = job.match(
      /\/\/ 目標に届くまで、上限と並列数の範囲で発射し続ける[\s\S]*?\{/,
    )![0];
    expect(loop).toContain("!touchFailed");
    expect(loop).toContain("!fatalStopped");
  });

  it("見出しを失ったら、走っている分を受け取ったあと確定を書きに行かない", () => {
    const after = job.slice(job.indexOf("await Promise.all(inflight)"));
    const lostAt = after.indexOf("if (lost)");
    expect(lostAt).toBeGreaterThan(-1);
    expect(lostAt).toBeLessThan(after.indexOf("const moreAttempts"));
    expect(lostAt).toBeLessThan(after.indexOf("fetchPoeRunPoints"));
  });

  it("生存確認は、持ち越した画像を拾うより先に始まる", () => {
    expect(job.indexOf("const heartbeat = (async")).toBeLessThan(
      job.indexOf("await drainPendingCaptures("),
    );
  });

  it("単発の生成も、行が消えたら読むのをやめる", () => {
    const single = fn("runSingleGeneration");
    const write = single.match(/const write = async[\s\S]*?\n {2}};/)![0];
    expect(write).toContain("!applied");
  });
});

describe("取りこぼしと数え漏れ", () => {
  const job = fn("runRetryGenerationJob");
  const acceptOne = job.match(/const acceptOne = async[\s\S]*?\n {2}};/)![0];

  it("届いた成功は、数え上げの前でも枠の計算に入る", () => {
    const loop = job.match(
      /\/\/ 目標に届くまで、上限と並列数の範囲で発射し続ける[\s\S]*?\{/,
    )![0];
    expect(loop).toContain("knownSuccesses() < retry.target");
    expect(loop).toContain("running() < slots()");
    const slots = job.match(/const slots = \(\): number =>[\s\S]*?;/)![0];
    expect(slots).toContain("successes: knownSuccesses()");
    expect(slots).toContain("attempts: state.attempts + pending.settled()");
    // 届いたときに足し、数えたら引く
    const accept = job.match(/const accept = \(r: AttemptOutcome\)[\s\S]*?\n {2}};/)![0];
    expect(accept).toContain("pending.known(r.kind)");
    expect(accept).toContain("pending.counted(r.kind)");
  });

  it("成功は保存できた時点で数え、画像の取り込みの失敗で取り消さない", () => {
    const success = acceptOne.slice(acceptOne.indexOf("await appendAssistantMessage("));
    const counted = success.indexOf("state.successes++");
    expect(counted).toBeGreaterThan(-1);
    expect(counted).toBeLessThan(success.indexOf("captureGeneratedImages("));
    expect(success.indexOf("state.parentId = id")).toBeLessThan(
      success.indexOf("captureGeneratedImages("),
    );
  });

  it("直らないエラーはその場で止め、一時的な不調は試行に数えず待つ", () => {
    expect(acceptOne).toContain('if (r.kind === "fatal")');
    expect(acceptOne).toContain("fatalStopped = true");
    expect(acceptOne).toContain('if (r.kind === "transient")');
    expect(acceptOne).toContain("onTransientFailure(");
    // 一時的な不調の分岐は attempts++ より前で return する
    const transientAt = acceptOne.indexOf('if (r.kind === "transient")');
    const attemptsAt = acceptOne.indexOf("state.attempts++");
    expect(transientAt).toBeGreaterThan(-1);
    expect(transientAt).toBeLessThan(attemptsAt);
    expect(acceptOne).not.toContain("consecutiveErrors");
  });

  it("成功か拒否が返ったら待ち直しの回数を戻し、待ちの時刻は持ち越す", () => {
    expect(acceptOne).toContain("afterAttemptSettled(");
    expect(acceptOne).toContain("state.pauseUntil = next.pauseUntil");
    expect(job).toContain("Math.max(state.pauseUntil, gate.until())");
    // 持ち越しの復元（前の版が保存した state には無い）
    const restore = source.slice(source.indexOf("function restoreRetryState"));
    expect(restore.slice(0, restore.indexOf("\n}"))).toContain(
      "pauseUntil: previous.pauseUntil ?? 0",
    );
  });
});

describe("台帳と課金", () => {
  const job = fn("runRetryGenerationJob");

  it("拒否された応答の usage を捨てず、OpenRouter では台帳へ載せる", () => {
    const attempt = fn("runAttempt");
    expect(attempt).toContain('kind: "refused", text: result.content, usageJson: result.usageJson');
    const acceptOne = job.match(/const acceptOne = async[\s\S]*?\n {2}};/)![0];
    expect(acceptOne).toContain("if (!isPoe) await recordRefusalUsage(job.model, r.usageJson)");
  });

  it("Poe の実行全体の消費は、枠の残りに関係なく取りに行く", () => {
    const tail = job.slice(job.indexOf("const moreAttempts"));
    const guard = tail.match(/if \(isPoe && state\.attempts > 0[^)]*\)/)![0];
    expect(guard).not.toContain("budget.available()");
  });

  it("Poe の続きの実行は、ここまでの消費を月間上限の判定に足す", () => {
    expect(job).toContain("checkMonthlyLimit(Date.now(), state.provisional)");
    expect(job).toContain("state.provisional = { points: soFar.points");
  });

  it("失敗の分け方は upstream-outcome に一本化し、HTTP のエラーも本文の中のエラーも通す", () => {
    const attempt = fn("runAttempt");
    const http = attempt.slice(attempt.indexOf("if (!upstream.ok || !upstream.body)"));
    expect(http).toContain("classifyUpstreamFailure({");
    expect(http).toContain("status: upstream.status");
    // 本文は一度しか読めないので、読んだものを文言の組み立てにも渡す
    expect(http).toContain("upstreamErrorMessage(upstream, isPoe, body)");
    const mid = attempt.slice(attempt.indexOf("if (!hasImage && result.error)"));
    expect(mid).toContain("classifyUpstreamFailure({");
    expect(mid).toContain("status: result.error.code");
    // 文言での判定は runAttempt に残っていない（分け方は1か所）
    expect(attempt).not.toContain("isSafetyRejection");
    expect(attempt).not.toContain("MODERATION");
  });

  it("画像を出すモデルは、ヘッダを待つ時間も本文の無音も長く取り、締め切りの signal を渡す", () => {
    const attempt = fn("runAttempt");
    expect(attempt).toMatch(
      /const idleTimeoutMs = job\.imageOutput\s*\?\s*IMAGE_IDLE_TIMEOUT_MS\s*:\s*UPSTREAM_IDLE_TIMEOUT_MS/,
    );
    expect(attempt).toContain("connectTimeoutMs: idleTimeoutMs,");
    const req = attempt.slice(attempt.indexOf("requestUpstream(job, messages, onRequest, {"));
    expect(req.slice(0, req.indexOf("})"))).toContain("signal,");
  });

  it("1本ごとに総時間の締め切りを置き、停止後は猶予の後に切る", () => {
    const launch = job.match(/const launch = \(\) => \{[\s\S]*?\n {2}};/)![0];
    expect(launch).toContain("new AbortController()");
    expect(launch).toContain("RETRY_ATTEMPT_DEADLINE_MS");
    expect(launch).toContain("controller.signal");
    expect(launch).toContain("clearTimeout(deadline)");
    const touch = job.match(/const touch = async[\s\S]*?\n {2}};/)![0];
    expect(touch).toContain("if (stopped) armStopGrace()");
    expect(job).toContain("RETRY_STOP_GRACE_MS");
    const attempt = fn("runAttempt");
    expect(attempt).toContain("signal,");
  });

});
