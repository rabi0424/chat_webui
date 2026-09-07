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
  createChunkBudget,
  createPendingTally,
  formatRetryProgress,
  interruptedGenerationRow,
  shouldFinalizeLostRun,
  isRetryProgress,
  parseRetryProgress,
  retryRequestCap,
  RETRY_ALARM_WALL_MS,
  RETRY_ATTEMPT_DEADLINE_MS,
  RETRY_CHUNK_INTERNAL_LIMIT,
  RETRY_WORKER_ATTEMPTS,
  RETRY_WORKER_CONCURRENCY,
  RETRY_WORKER_LAUNCH_WINDOW_MS,
  RETRY_MAX_SPAWNS_PER_TICK,
  RETRY_REQUEST_CAP_FACTOR,
  RETRY_STALLED_CHUNK_LIMIT,
  onTransientFailure,
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
  const full = {
    target: 3,
    successes: 1,
    attempts: 6,
    maxAttempts: 1000,
    refusals: 4,
    emptyResponses: 0,
    transients: 1,
    running: 2,
    slots: 3,
    waitSeconds: 12,
    stopping: true,
  };

  it("見出しとして判別できる形で書き、素で読んでも意味が取れる", () => {
    const line = formatRetryProgress(full);
    expect(isRetryProgress(line)).toBe(true);
    expect(line).toBe(
      "生成中… 成功 1/3・投げた 6/1000・拒否 4・不調 1・待ち 2本・枠 3本・レート制限で待機 あと12秒・停止中",
    );
  });

  it("書いたものを読むと同じ進捗に戻る（0 の内訳や無い状態も）", () => {
    expect(parseRetryProgress(formatRetryProgress(full))).toEqual(full);
    const quiet = {
      ...full,
      successes: 0,
      refusals: 0,
      transients: 0,
      running: 0,
      slots: 1,
      waitSeconds: 0,
      stopping: false,
    };
    const line = formatRetryProgress(quiet);
    expect(line).toBe("生成中… 成功 0/3・投げた 6/1000・待ち 0本・枠 1本");
    expect(parseRetryProgress(line)).toEqual(quiet);
  });

  it("桁が違っても、項の並びが違っても読める", () => {
    const big = { ...full, attempts: 999, maxAttempts: 1000, refusals: 990, slots: 12, waitSeconds: 60 };
    expect(parseRetryProgress(formatRetryProgress(big))).toEqual(big);
    // 「空 N」と「不調 N」を「拒否 N」と取り違えない
    const only = { ...full, refusals: 0, emptyResponses: 7, transients: 0, stopping: false, waitSeconds: 0 };
    expect(parseRetryProgress(formatRetryProgress(only))).toEqual(only);
  });

  it("読めない見出しは null（古い版の1行は素のまま出す側へ倒す）", () => {
    expect(parseRetryProgress("生成中… 成功 0/3・試行 6/1000・実行中 1本")).toBeNull();
    expect(parseRetryProgress("生成中…")).toBeNull();
    expect(parseRetryProgress("画像を生成しました。")).toBeNull();
  });

  it("経過秒はサーバー側で書かない（クライアントが刻む）", () => {
    const line = formatRetryProgress({ ...full, waitSeconds: 0 });
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
describe("一時的な不調の待ち直し", () => {
  const fresh = () => ({ pauseUntil: 0, rounds: 0 });

  it("最初の1件で待ちに入り、1回と数える", () => {
    const s = onTransientFailure(fresh(), { now: 1000 });
    expect(s.rounds).toBe(1);
    expect(s.pauseUntil).toBe(1000 + RATE_LIMIT_BACKOFF_MS[0]);
  });

  /** これが直したかったところ。 */
  it("待っている最中に来た分は、同じ回として数えない", () => {
    let s = onTransientFailure(fresh(), { now: 1000 });
    // 並列4なら、残り3件がほぼ同時に返る
    s = onTransientFailure(s, { now: 1001 });
    s = onTransientFailure(s, { now: 1002 });
    s = onTransientFailure(s, { now: 1003 });
    expect(s.rounds).toBe(1);
  });

  it("何回続いても打ち切らず、待ちは60秒で頭打ち", () => {
    let s = fresh();
    let now = 1000;
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 4; i++) s = onTransientFailure(s, { now: now + i });
      now = s.pauseUntil + 1; // 待ち終わって投げ直す
    }
    expect(s.rounds).toBe(20);
    // 20回目の待ちも最後の値で、打ち切りの印はどこにも無い
    expect(s.pauseUntil).toBe(now - 1);
    expect(s.pauseUntil - (now - 1 - RATE_LIMIT_BACKOFF_MS.at(-1)!)).toBe(
      RATE_LIMIT_BACKOFF_MS.at(-1),
    );
    expect(RATE_LIMIT_BACKOFF_MS.at(-1)).toBe(60_000);
    expect("exhausted" in s).toBe(false);
  });

  it("待ちは回を追うごとに伸びる", () => {
    let s = onTransientFailure(fresh(), { now: 0 });
    expect(s.pauseUntil).toBe(RATE_LIMIT_BACKOFF_MS[0]);
    s = onTransientFailure(s, { now: s.pauseUntil });
    expect(s.pauseUntil - RATE_LIMIT_BACKOFF_MS[0]).toBe(
      RATE_LIMIT_BACKOFF_MS[1],
    );
    for (let i = 1; i < RATE_LIMIT_BACKOFF_MS.length; i++) {
      expect(RATE_LIMIT_BACKOFF_MS[i]).toBeGreaterThan(RATE_LIMIT_BACKOFF_MS[i - 1]);
    }
  });

  it("上流が待ち時間を言えばそれに従う", () => {
    const s = onTransientFailure(fresh(), { now: 1000, waitMs: 30_000 });
    expect(s.pauseUntil).toBe(31_000);
  });

  it("余波でも、上流が長い待ちを言えば伸ばす", () => {
    // 短いほうで先に投げ直すと、また同じ制限に当たる
    let s = onTransientFailure(fresh(), { now: 1000 });
    const before = s.pauseUntil;
    s = onTransientFailure(s, { now: 1001, waitMs: 60_000 });
    expect(s.pauseUntil).toBe(61_001);
    expect(s.pauseUntil).toBeGreaterThan(before);
    expect(s.rounds).toBe(1);
  });

  it("余波の待ちが短くても、縮めはしない", () => {
    let s = onTransientFailure(fresh(), { now: 1000, waitMs: 60_000 });
    s = onTransientFailure(s, { now: 1001, waitMs: 10 });
    expect(s.pauseUntil).toBe(61_000);
  });

  it("待ち時間が0以下なら、既定の待ちを使う", () => {
    const s = onTransientFailure(fresh(), { now: 1000, waitMs: 0 });
    expect(s.pauseUntil).toBe(1000 + RATE_LIMIT_BACKOFF_MS[0]);
  });
});

describe("待ち直しの回数の戻し", () => {
  it("成功か拒否が返ったら回数を 0 に戻し、待ちの時刻は保つ", () => {
    const next = afterAttemptSettled({ pauseUntil: 9_000, rounds: 2 });
    expect(next.rounds).toBe(0);
    expect(next.pauseUntil).toBe(9_000);
  });

  it("戻したあとは、待ちが短いところから始まる", () => {
    let st = { pauseUntil: 0, rounds: 5 };
    st = afterAttemptSettled(st);
    st = onTransientFailure(st, { now: 100_000 });
    expect(st.pauseUntil).toBe(100_000 + RATE_LIMIT_BACKOFF_MS[0]);
  });
});

/**
 * 届いているがまだ数えていない本数。known と counted が対になって
 * いないと、成功が届くたびに枠が1本ずつ狭まったまま戻らない。
 */
describe("createPendingTally", () => {
  it("成功と拒否を、届いたときに足し、数えたときに引く", () => {
    const t = createPendingTally();
    t.known("success");
    t.known("refused");
    expect(t.successes()).toBe(1);
    expect(t.settled()).toBe(2);
    t.counted("success");
    expect(t.successes()).toBe(0);
    expect(t.settled()).toBe(1);
    t.counted("refused");
    expect(t.settled()).toBe(0);
  });

  it("一時的な不調と直らないエラーは試行ではないので数えない", () => {
    const t = createPendingTally();
    t.known("transient");
    t.known("fatal");
    expect(t.settled()).toBe(0);
    expect(t.successes()).toBe(0);
    t.counted("transient");
    t.counted("fatal");
    expect(t.settled()).toBe(0);
  });
});

/**
 * いちばん外側の柵。試行回数・待ち直し・並列数をどう組み合わせても、
 * 上流へ投げる本数がこれを越えないことを、発射ループの配線と合わせて
 * 保証する（retry-stop-wiring.test.ts）。数そのものはここで固定する。
 */
describe("上流への本数の柵", () => {
  it("上限試行回数の3倍で、上限が壊れていても1本は投げられる", () => {
    expect(RETRY_REQUEST_CAP_FACTOR).toBe(3);
    expect(retryRequestCap(5)).toBe(15);
    expect(retryRequestCap(100)).toBe(300);
    expect(retryRequestCap(0)).toBe(3);
    expect(retryRequestCap(-1)).toBe(3);
  });

  it("進まないチャンクは3回で終える", () => {
    expect(RETRY_STALLED_CHUNK_LIMIT).toBe(3);
  });

  /**
   * 15分の壁（Cloudflare: Durable Object のアラームは最長15分）。
   * 1本担当の実行は自分の壁の手前で必ず結果を書く。
   */
  it("担当は、波を2つ回しても壁の手前で終わる", () => {
    expect(RETRY_ALARM_WALL_MS).toBe(15 * 60_000);
    // 窓のぎりぎりに始めた最後の1本が締め切りまで粘っても、壁に届かない
    expect(RETRY_WORKER_LAUNCH_WINDOW_MS + RETRY_ATTEMPT_DEADLINE_MS).toBeLessThan(
      RETRY_ALARM_WALL_MS - 60_000,
    );
    // 引き受けた数を同時数で割った波の数ぶん、窓の中に収まる
    const waves = Math.ceil(RETRY_WORKER_ATTEMPTS / RETRY_WORKER_CONCURRENCY);
    expect(waves).toBe(2);
    expect((waves - 1) * RETRY_ATTEMPT_DEADLINE_MS).toBeLessThanOrEqual(
      RETRY_WORKER_LAUNCH_WINDOW_MS,
    );
  });

  /**
   * Durable Object は「実行体1つが起きている時間」で課金され、外の応答を
   * 待つあいだも含む。依頼1本ごとに実行体を分けると並列数だけ倍に課金
   * され、368本の実行1回で日の枠の6割を使い切った。1つの実行体の中で
   * 同時に投げれば、待ち時間は1本ぶんしか課金されない。
   */
  it("担当は複数の依頼を引き受け、同時数は接続の上限に合わせる", () => {
    expect(RETRY_WORKER_CONCURRENCY).toBe(6);
    expect(RETRY_WORKER_ATTEMPTS).toBeGreaterThan(RETRY_WORKER_CONCURRENCY);
    // 依頼1本あたりの実行体の時間が、分けたときの何分の1になるか
    expect(RETRY_WORKER_ATTEMPTS / RETRY_WORKER_CONCURRENCY).toBeGreaterThanOrEqual(2);
  });
});

/**
 * 続きの実行1回で使ってよい内部サービス（D1）の枠。
 *
 * 使い切ると以降の D1 が全部失敗し、見出しの打ち直しも通らなくなって、
 * 60秒の無更新で中断とみなされて実行が黙って終わる。実際に並列100で
 * 起きた（368本を起こしたところで枠が尽き、318秒の見出しが残った）。
 */
describe("続きの実行の枠", () => {
  it("使った分を数え、上限に届いたら続けない", () => {
    const b = createChunkBudget(10);
    expect(b.ok()).toBe(true);
    b.spend(9);
    expect(b.spent()).toBe(9);
    expect(b.ok()).toBe(true);
    b.spend();
    expect(b.spent()).toBe(10);
    expect(b.ok()).toBe(false);
  });

  it("これから使う余地があるかを、まとめて聞ける", () => {
    const b = createChunkBudget(10);
    b.spend(7);
    expect(b.room(3)).toBe(true);
    expect(b.room(4)).toBe(false);
  });

  it("上限は無料プランの1,000件より手前（確定の分を残す）", () => {
    expect(RETRY_CHUNK_INTERNAL_LIMIT).toBeLessThanOrEqual(900);
    expect(RETRY_CHUNK_INTERNAL_LIMIT).toBeGreaterThan(100);
    expect(createChunkBudget().ok()).toBe(true);
  });

  it("1回の往復で起こす数は、見出しを打ち直せる程度に区切る", () => {
    // 起こすのに1本200ms。区切らないと並列100で20秒以上黙り、
    // 中断とみなされる60秒に近づく
    expect(RETRY_MAX_SPAWNS_PER_TICK).toBeLessThanOrEqual(20);
    expect(RETRY_MAX_SPAWNS_PER_TICK).toBeGreaterThan(1);
  });
});

/**
 * 中断とみなされた行の確定。「成功するまで生成」の見出しをそのまま
 * done にすると、止まった数字の1行が会話に残り続ける（実際にそう見えた）。
 */
describe("interruptedGenerationRow", () => {
  it("進捗の見出しは、本文を残さずエラーとして確定する", () => {
    const line = formatRetryProgress({
      target: 3,
      successes: 1,
      attempts: 368,
      maxAttempts: 1000,
      refusals: 367,
      emptyResponses: 0,
      transients: 0,
      running: 100,
      slots: 100,
      waitSeconds: 0,
      stopping: false,
    });
    const out = interruptedGenerationRow(line);
    expect(out.status).toBe("error");
    expect(out.content).toBe("");
    expect(out.error).toContain("下に残っている応答はそのまま使えます");
  });

  it("途中まで書けた応答は、そのまま残す", () => {
    expect(interruptedGenerationRow("猫の絵です")).toEqual({
      status: "done",
      content: "猫の絵です",
      error: null,
    });
  });

  it("何も書けていなければ、再試行できるようエラーにする", () => {
    const out = interruptedGenerationRow("");
    expect(out.status).toBe("error");
    expect(out.error).toBe("生成が中断されました。再試行してください。");
  });
});

/**
 * 途中経過が残っていないアラームで、行を確定させるか。
 *
 * 旧方式では再入＝投げ直しだったので確定させていた。「成功するまで生成」
 * は D1 から組み直せるので再入して続ける。ここを取り違えると、走り出した
 * 直後の実行が「生成が中断されました」で終わる（実際に起きた）。
 */
describe("shouldFinalizeLostRun", () => {
  const progress = "生成中… 成功 0/3・投げた 0/1000・待ち 4本・枠 4本";

  it("「成功するまで生成」は、途中経過が無くても確定させない（再入して続ける）", () => {
    expect(
      shouldFinalizeLostRun({ retry: true, hasState: false, content: progress }),
    ).toBe(false);
    expect(
      shouldFinalizeLostRun({ retry: true, hasState: false, content: "" }),
    ).toBe(false);
  });

  it("単発の生成は、本文が書かれていたら確定させる（再入すると二重課金）", () => {
    expect(
      shouldFinalizeLostRun({ retry: false, hasState: false, content: "猫の絵" }),
    ).toBe(true);
  });

  it("本文が空なら、まだ何も受け取っていないのでそのまま走らせる", () => {
    expect(
      shouldFinalizeLostRun({ retry: false, hasState: false, content: "" }),
    ).toBe(false);
  });

  it("途中経過があるなら、どちらでも続きを走らせる", () => {
    for (const retry of [true, false]) {
      expect(
        shouldFinalizeLostRun({ retry, hasState: true, content: "猫の絵" }),
      ).toBe(false);
    }
  });
});
