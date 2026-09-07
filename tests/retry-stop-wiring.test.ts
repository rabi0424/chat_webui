import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * リトライ生成の発射ループの配線。
 *
 * 打ち切りの理由はローカル変数（stopped / rateLimitExhausted /
 * errorsExhausted / budgetStopped）に散っていて、続行判定（moreAttempts）
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
  it("打ち切りの理由が4つとも続行判定に入っている", () => {
    const m = source.match(/const moreAttempts =[\s\S]*?;/);
    expect(m).not.toBeNull();
    const expr = m![0];
    expect(expr).toContain("!stopped");
    expect(expr).toContain("!rateLimitExhausted");
    expect(expr).toContain("!errorsExhausted");
    expect(expr).toContain("!budgetStopped");
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
    expect(loop).toContain("!errorsExhausted");
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

  it("同じ失敗の連続を数え、成功か拒否で戻す", () => {
    expect(acceptOne).toContain("state.consecutiveErrors++");
    expect(acceptOne).toContain(
      "state.consecutiveErrors >= RETRY_CONSECUTIVE_ERROR_LIMIT",
    );
    expect(acceptOne.match(/state\.consecutiveErrors = 0/g)?.length).toBe(2);
  });

  it("レート制限以外が返ったら待ち直しの回数を戻し、待ちの時刻は持ち越す", () => {
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

  it("画像を出すモデルは、無音の待ちを長くする", () => {
    const attempt = fn("runAttempt");
    expect(attempt).toContain(
      "job.imageOutput ? IMAGE_IDLE_TIMEOUT_MS : UPSTREAM_IDLE_TIMEOUT_MS",
    );
  });
});
