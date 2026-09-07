import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_BACKOFF_MS,
  RETRY_CONCURRENCY_KEY,
  RETRY_ENABLED_KEY,
  RETRY_MAX_KEY,
  RETRY_SMART_KEY,
  RETRY_SMART_PERCENT_KEY,
  RETRY_TARGET_KEY,
  afterAttemptSettled,
  createPendingTally,
  formatRetryProgress,
  isRetryProgress,
  isSafetyRejection,
  onRateLimited,
  readRetryConfig,
} from "../app/lib/retry";

/**
 * リトライ生成の設定は「課金の天井」を決める。
 * 上限を1つ読み違えるだけで、意図した何倍もの生成が走ってしまうため、
 * クライアントが何を送ってきても天井を越えないことを確かめる。
 */
const on = (extra: Record<string, number | string> = {}) => ({
  [RETRY_ENABLED_KEY]: "on",
  ...extra,
});

describe("readRetryConfig", () => {
  it("無効なら null を返す", () => {
    expect(readRetryConfig(null, 100)).toBeNull();
    expect(readRetryConfig(undefined, 100)).toBeNull();
    expect(readRetryConfig({}, 100)).toBeNull();
    expect(readRetryConfig({ [RETRY_ENABLED_KEY]: "off" }, 100)).toBeNull();
    // "on" 以外の値では有効にしない
    expect(readRetryConfig({ [RETRY_ENABLED_KEY]: "true" }, 100)).toBeNull();
    expect(readRetryConfig({ [RETRY_ENABLED_KEY]: 1 }, 100)).toBeNull();
  });

  it("未指定なら試行回数と並列数を目標数に合わせる", () => {
    expect(readRetryConfig(on({ [RETRY_TARGET_KEY]: 3 }), 100)).toEqual({
      target: 3,
      maxAttempts: 3,
      concurrency: 3,
      smartPercent: null,
    });
  });

  it("試行回数はアプリ全体の天井を超えない", () => {
    const c = readRetryConfig(
      on({ [RETRY_TARGET_KEY]: 5, [RETRY_MAX_KEY]: 9999 }),
      20,
    );
    expect(c?.maxAttempts).toBe(20);
  });

  it("並列数は試行回数を超えない", () => {
    const c = readRetryConfig(
      on({ [RETRY_TARGET_KEY]: 1, [RETRY_MAX_KEY]: 3, [RETRY_CONCURRENCY_KEY]: 50 }),
      100,
    );
    expect(c?.concurrency).toBe(3);
  });

  it("壊れた値・負の値・小数でも天井を割らない", () => {
    for (const bad of ["abc", "", -1, 0, NaN, Infinity, "-5", null, undefined]) {
      const c = readRetryConfig(
        on({
          [RETRY_TARGET_KEY]: bad as never,
          [RETRY_MAX_KEY]: bad as never,
          [RETRY_CONCURRENCY_KEY]: bad as never,
        }),
        10,
      );
      expect(c).not.toBeNull();
      expect(c!.target).toBeGreaterThanOrEqual(1);
      expect(c!.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(c!.maxAttempts).toBeLessThanOrEqual(10);
      expect(c!.concurrency).toBeGreaterThanOrEqual(1);
      expect(c!.concurrency).toBeLessThanOrEqual(c!.maxAttempts);
    }
  });

  it("小数は丸めて整数にする", () => {
    const c = readRetryConfig(
      on({ [RETRY_TARGET_KEY]: 2.7, [RETRY_MAX_KEY]: 4.2 }),
      100,
    );
    expect(c).toEqual({
      target: 3,
      maxAttempts: 4,
      concurrency: 3,
      smartPercent: null,
    });
  });

  it("天井が0や負でも、必ず1回は試せる形にする", () => {
    for (const ceiling of [0, -1, 0.4]) {
      const c = readRetryConfig(on({ [RETRY_TARGET_KEY]: 5 }), ceiling);
      expect(c!.maxAttempts).toBe(1);
      expect(c!.concurrency).toBe(1);
    }
  });

  it("文字列で送られた数値も読む（フォームからの値）", () => {
    expect(
      readRetryConfig(on({ [RETRY_TARGET_KEY]: "4", [RETRY_MAX_KEY]: "8" }), 100),
    ).toEqual({ target: 4, maxAttempts: 8, concurrency: 4, smartPercent: null });
  });

  /**
   * スマート生成。並列数は「上限」になる。未入力の既定を目標数の
   * ままにすると、目標1のとき枠が1本から増やせず、失敗が続いても何も
   * しない「スマート」になるので、既定は上限の試行回数に置く。
   */
  describe("スマート生成", () => {
    it('"on" のときだけ有効で、割合の既定は 10%', () => {
      expect(
        readRetryConfig(on({ [RETRY_SMART_KEY]: "on" }), 100)?.smartPercent,
      ).toBe(10);
      expect(
        readRetryConfig(on({ [RETRY_SMART_KEY]: "off" }), 100)?.smartPercent,
      ).toBeNull();
      expect(
        readRetryConfig(on({ [RETRY_SMART_KEY]: true }), 100)?.smartPercent,
      ).toBeNull();
      expect(readRetryConfig(on(), 100)?.smartPercent).toBeNull();
      // スイッチが切れていれば割合だけ残っていても効かない
      expect(
        readRetryConfig(on({ [RETRY_SMART_PERCENT_KEY]: 30 }), 100)
          ?.smartPercent,
      ).toBeNull();
    });

    it("割合は 1〜50 に収める（0 や 100 は統計として意味を持たない）", () => {
      const at = (v: unknown) =>
        readRetryConfig(
          on({ [RETRY_SMART_KEY]: "on", [RETRY_SMART_PERCENT_KEY]: v as never }),
          100,
        )?.smartPercent;
      expect(at(30)).toBe(30);
      expect(at("25")).toBe(25);
      expect(at(0)).toBe(10);
      expect(at(-5)).toBe(10);
      // 1未満は丸めて0になり、最小の1へ引き上げる（他の欄と同じ扱い）
      expect(at(0.4)).toBe(1);
      expect(at(100)).toBe(50);
      expect(at("abc")).toBe(10);
    });

    it("並列数が未入力なら上限を試行回数に合わせる（目標数ではない）", () => {
      expect(
        readRetryConfig(
          on({ [RETRY_SMART_KEY]: "on", [RETRY_TARGET_KEY]: 1, [RETRY_MAX_KEY]: 8 }),
          100,
        ),
      ).toEqual({ target: 1, maxAttempts: 8, concurrency: 8, smartPercent: 10 });
    });

    it("入力した並列数はそのまま上限になり、試行回数は超えない", () => {
      const c = readRetryConfig(
        on({
          [RETRY_SMART_KEY]: "on",
          [RETRY_TARGET_KEY]: 1,
          [RETRY_MAX_KEY]: 8,
          [RETRY_CONCURRENCY_KEY]: 3,
        }),
        100,
      );
      expect(c?.concurrency).toBe(3);
      const over = readRetryConfig(
        on({
          [RETRY_SMART_KEY]: "on",
          [RETRY_MAX_KEY]: 8,
          [RETRY_CONCURRENCY_KEY]: 50,
        }),
        100,
      );
      expect(over?.concurrency).toBe(8);
    });
  });
});

describe("進捗の見出し", () => {
  const retry = { target: 10, maxAttempts: 100, concurrency: 4 };

  it("見出しとして判別できる形で書く", () => {
    const line = formatRetryProgress({
      successes: 2,
      attempts: 37,
      inflight: 4,
      retry,
    });
    expect(isRetryProgress(line)).toBe(true);
    expect(line).toContain("成功 2/10");
    expect(line).toContain("試行 37/100");
    expect(line).toContain("実行中 4本");
  });

  it("経過秒はサーバー側で書かない（クライアントが刻む）", () => {
    const line = formatRetryProgress({
      successes: 0,
      attempts: 0,
      inflight: 0,
      retry,
    });
    expect(line).not.toMatch(/秒|\d+s\b/);
  });

  it("通常の応答は見出しと誤判定しない", () => {
    expect(isRetryProgress("画像を生成しました。")).toBe(false);
    expect(isRetryProgress("")).toBe(false);
  });
});

/**
 * レート制限の待ち直し。
 *
 * **並列で走っている本数ぶんの応答が、ほぼ同時に 429 で返る。**
 * 1つ受けるたびに回数を増やしていたので、並列4なら1回の制限で
 * 待ち直しの上限（3回）を使い切り、一度も待たずに打ち切っていた。
 * 課金は済んでいるのに成果は無い、という終わり方になる。
 */
describe("レート制限の待ち直し", () => {
  const fresh = () => ({ pauseUntil: 0, rounds: 0, exhausted: false });

  it("最初の1件で待ちに入り、1回と数える", () => {
    const s = onRateLimited(fresh(), { now: 1000 });
    expect(s.rounds).toBe(1);
    expect(s.pauseUntil).toBe(1000 + RATE_LIMIT_BACKOFF_MS[0]);
    expect(s.exhausted).toBe(false);
  });

  /** これが直したかったところ。 */
  it("待っている最中に来た分は、同じ回として数えない", () => {
    let s = onRateLimited(fresh(), { now: 1000 });
    // 並列4なら、残り3件がほぼ同時に返る
    s = onRateLimited(s, { now: 1001 });
    s = onRateLimited(s, { now: 1002 });
    s = onRateLimited(s, { now: 1003 });
    expect(s.rounds).toBe(1);
    expect(s.exhausted).toBe(false);
  });

  it("並列4でも、待ち直しの上限まで3回ぶん粘れる", () => {
    let s = fresh();
    let now = 1000;
    for (let round = 0; round < 3; round++) {
      // 1回の制限で4件返る
      for (let i = 0; i < 4; i++) s = onRateLimited(s, { now: now + i });
      expect(s.exhausted).toBe(false);
      now = s.pauseUntil + 1; // 待ち終わって投げ直す
    }
    expect(s.rounds).toBe(3);
    // 4回目でようやく打ち切る
    s = onRateLimited(s, { now });
    expect(s.exhausted).toBe(true);
  });

  it("待ちは回を追うごとに伸びる", () => {
    let s = onRateLimited(fresh(), { now: 0 });
    expect(s.pauseUntil).toBe(RATE_LIMIT_BACKOFF_MS[0]);
    s = onRateLimited(s, { now: s.pauseUntil });
    expect(s.pauseUntil - RATE_LIMIT_BACKOFF_MS[0]).toBe(
      RATE_LIMIT_BACKOFF_MS[1],
    );
  });

  it("上流が待ち時間を言えばそれに従う", () => {
    const s = onRateLimited(fresh(), { now: 1000, waitMs: 30_000 });
    expect(s.pauseUntil).toBe(31_000);
  });

  it("余波でも、上流が長い待ちを言えば伸ばす", () => {
    // 短いほうで先に投げ直すと、また同じ制限に当たる
    let s = onRateLimited(fresh(), { now: 1000 });
    const before = s.pauseUntil;
    s = onRateLimited(s, { now: 1001, waitMs: 60_000 });
    expect(s.pauseUntil).toBe(61_001);
    expect(s.pauseUntil).toBeGreaterThan(before);
    expect(s.rounds).toBe(1);
  });

  it("余波の待ちが短くても、縮めはしない", () => {
    let s = onRateLimited(fresh(), { now: 1000, waitMs: 60_000 });
    s = onRateLimited(s, { now: 1001, waitMs: 10 });
    expect(s.pauseUntil).toBe(61_000);
  });

  it("待ち時間が0以下なら、既定の待ちを使う", () => {
    const s = onRateLimited(fresh(), { now: 1000, waitMs: 0 });
    expect(s.pauseUntil).toBe(1000 + RATE_LIMIT_BACKOFF_MS[0]);
  });
});

describe("待ち直しの回数の戻し", () => {
  it("レート制限以外の結果が返ったら回数を 0 に戻し、待ちの時刻は保つ", () => {
    const next = afterAttemptSettled({ pauseUntil: 9_000, rounds: 2, exhausted: false });
    expect(next.rounds).toBe(0);
    expect(next.pauseUntil).toBe(9_000);
  });

  it("戻したあとは、また上限まで待ち直せる", () => {
    // 2回待ったあとに1本通り、そのあと制限が続いても3回ぶん粘れる
    let st = { pauseUntil: 0, rounds: 2, exhausted: false };
    st = afterAttemptSettled(st);
    let now = 100_000;
    for (let i = 0; i < 3; i++) {
      st = onRateLimited(st, { now });
      expect(st.exhausted).toBe(false);
      now = st.pauseUntil + 1;
    }
    expect(onRateLimited(st, { now }).exhausted).toBe(true);
  });
});

/**
 * 届いているがまだ数えていない本数。known と counted が対になって
 * いないと、成功が届くたびに枠が1本ずつ狭まったまま戻らない。
 */
describe("createPendingTally", () => {
  it("成功と試行を、届いたときに足し、数えたときに引く", () => {
    const t = createPendingTally();
    t.known("success");
    t.known("refused");
    t.known("error");
    expect(t.successes()).toBe(1);
    expect(t.settled()).toBe(3);
    t.counted("success");
    expect(t.successes()).toBe(0);
    expect(t.settled()).toBe(2);
    t.counted("refused");
    t.counted("error");
    expect(t.settled()).toBe(0);
  });

  it("レート制限は試行ではないので数えない", () => {
    const t = createPendingTally();
    t.known("rate_limited");
    expect(t.settled()).toBe(0);
    expect(t.successes()).toBe(0);
    t.counted("rate_limited");
    expect(t.settled()).toBe(0);
  });
});

/**
 * 上流のエラー応答のうち、セーフティ判定による拒否を見分ける。
 * エラーとして扱うと「同じ失敗が続いたら打ち切る」に掛かり、
 * 乗り越えるための機能が5回の拒否で止まる。
 */
describe("isSafetyRejection", () => {
  it("API の定型文と code を拒否と読む", () => {
    expect(
      isSafetyRejection(
        400,
        "Your request was rejected by the safety system. If you believe this is an error, contact us at help.openai.com and include the request ID",
      ),
    ).toBe(true);
    expect(isSafetyRejection(400, "content_policy_violation")).toBe(true);
    expect(isSafetyRejection(400, "moderation_blocked")).toBe(true);
    expect(
      isSafetyRejection(403, "This request violates our usage policy."),
    ).toBe(true);
    expect(isSafetyRejection(422, "Content Policy Violation")).toBe(true);
  });

  it("直らないエラーを拒否と読まない", () => {
    expect(isSafetyRejection(400, "Unknown parameter: 'foo'")).toBe(false);
    expect(isSafetyRejection(400, "Invalid JSON body")).toBe(false);
    expect(isSafetyRejection(500, "internal error")).toBe(false);
  });

  it("認証・残高・レート制限は文言に何があっても拒否ではない", () => {
    expect(isSafetyRejection(401, "rejected by the safety system")).toBe(false);
    expect(isSafetyRejection(402, "content policy: insufficient credits")).toBe(false);
    expect(isSafetyRejection(429, "moderation rate limit")).toBe(false);
  });
});
