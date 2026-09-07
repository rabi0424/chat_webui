/**
 * リトライ生成（成功するまで生成）の設定。サーバー/クライアント共用。
 *
 * 画像生成はセーフティ判定に揺らぎがあり、問題のない依頼でも弾かれる
 * ことがある。同じ依頼をそのまま投げ直せば通ることが多いため、
 * 成功が目標数に達するまで自動で投げ直し、上限試行回数で打ち切る。
 *
 * 方針:
 * - 成功の判定は「応答に画像が1枚以上あるか」だけ。拒否文の文言は見ない
 *   （言語や表現に依存して壊れるため）。
 * - プロンプトは書き換えない。同じ依頼をそのまま再送するだけ。
 * - レート制限（429）は待ってから再送し、試行回数を消費しない。
 *   ただし待ち直しの回数にも別の上限を設ける。
 * - 上限試行回数はアプリ全体の天井（設定画面）を超えられない。
 *
 * 設定値は会話の params に予約キーで持つ（生成パラメータではないため、
 * buildGenerationPayload からは読まれない）。
 */

import {
  RETRY_SMART_DEFAULT_PERCENT,
  RETRY_SMART_MAX_PERCENT,
  RETRY_SMART_MIN_PERCENT,
} from "./retry-slots";

export const RETRY_ENABLED_KEY = "retry";
export const RETRY_TARGET_KEY = "retryTarget";
export const RETRY_MAX_KEY = "retryMax";
export const RETRY_CONCURRENCY_KEY = "retryConcurrency";
export const RETRY_SMART_KEY = "retrySmart";
export const RETRY_SMART_PERCENT_KEY = "retrySmartPercent";

export interface RetryConfig {
  /** ほしい成功応答の数。 */
  target: number;
  /** あきらめるまでの試行回数。 */
  maxAttempts: number;
  /**
   * 同時に走らせる数。目標数を超えてもよい（超過分の成功も残す）。
   * スマート生成のときは上限で、実際の本数は実行中の成功率から決め直す
   * （`app/lib/retry-slots.ts`）。
   */
  concurrency: number;
  /**
   * スマート生成。枠の数を固定せず、その実行の成功率から決め直す。
   * 失敗続きに反応して枠を増やしたとたん成功が一斉に届き、超過分が
   * 課金されるのを抑えるため。値は「はずれ／あたりと見なす割合（%）」。
   * null なら固定の並列数。
   */
  smartPercent: number | null;
}

export const RETRY_DEFAULT_TARGET = 1;
export const RETRY_DEFAULT_MAX_ATTEMPTS = 5;

/** レート制限で待ち直す回数の上限（試行回数とは別勘定）。 */
export const RETRY_RATE_LIMIT_ROUNDS = 3;

function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/**
 * 会話の params からリトライ設定を読む。無効なら null。
 *
 * ceiling はアプリ全体の天井。クライアントの値を信用せず、
 * 送信のたびにサーバー側でも通す。
 *
 * 並列数が未入力のときの既定は、固定なら目標数、スマートなら上限の
 * 試行回数。スマートで目標数を既定にすると、目標1のとき枠が1本から
 * 増やせず、失敗が続いても何もしない「スマート」になる。
 */
export function readRetryConfig(
  state: Record<string, number | string> | null | undefined,
  ceiling: number,
): RetryConfig | null {
  if (!state || state[RETRY_ENABLED_KEY] !== "on") return null;

  const target = Math.max(
    1,
    toInt(state[RETRY_TARGET_KEY], RETRY_DEFAULT_TARGET),
  );
  const smart = state[RETRY_SMART_KEY] === "on";
  const smartPercent = smart
    ? Math.min(
        Math.max(
          toInt(state[RETRY_SMART_PERCENT_KEY], RETRY_SMART_DEFAULT_PERCENT),
          RETRY_SMART_MIN_PERCENT,
        ),
        RETRY_SMART_MAX_PERCENT,
      )
    : null;
  // 試行回数は、未入力なら目標数と同じとみなす
  const maxAttempts = Math.min(
    Math.max(1, toInt(state[RETRY_MAX_KEY], target)),
    Math.max(1, Math.round(ceiling)),
  );
  const concurrency = Math.min(
    Math.max(
      1,
      toInt(state[RETRY_CONCURRENCY_KEY], smart ? maxAttempts : target),
    ),
    maxAttempts,
  );

  return { target, maxAttempts, concurrency, smartPercent };
}

/**
 * 進捗行の先頭。クライアントはこれを見て「リトライ生成の見出し」と判断し、
 * 経過秒を自分で刻む（サーバーは秒を書かない）。
 */
export const RETRY_PROGRESS_PREFIX = "生成中…";

/**
 * 見出しメッセージに出す進捗の文言。
 *
 * 経過秒はここに入れない。秒をサーバーが書くと、毎秒表示するために
 * 1秒ごとのD1書き込みとポーリング取得が要る。数字が動くだけの行なので、
 * 開始時刻（メッセージのcreated_at）からクライアントが刻んだほうが
 * 正確で、しかも安い。
 */
export function formatRetryProgress(state: {
  successes: number;
  attempts: number;
  inflight: number;
  retry: RetryConfig;
}): string {
  return (
    `${RETRY_PROGRESS_PREFIX} 成功 ${state.successes}/${state.retry.target}・` +
    `試行 ${state.attempts}/${state.retry.maxAttempts}・` +
    `実行中 ${state.inflight}本`
  );
}

/** 進捗の見出しメッセージか（本文の見た目で判断する）。 */
export function isRetryProgress(content: string): boolean {
  return content.startsWith(RETRY_PROGRESS_PREFIX);
}

/** レート制限に当たったときの待ち時間（ミリ秒）。回を追うごとに伸ばす。 */
export const RATE_LIMIT_BACKOFF_MS = [2_000, 4_000, 8_000];

export interface RateLimitState {
  /** この時刻まで新しい発射を控える。 */
  pauseUntil: number;
  /** 待ち直した回数。 */
  rounds: number;
  /** 上限に達したので打ち切る。 */
  exhausted: boolean;
}

/**
 * レート制限の応答を1つ受けたときの、待ちと回数の更新。
 *
 * **並列で走っている本数ぶんの応答が、ほぼ同時に 429 で返る。**
 * 1つ受けるたびに回数を増やしていたので、並列4なら1回の制限で
 * 待ち直しの上限（3回）を使い切り、**一度も待たずに打ち切って**いた。
 * 課金は済んでいるのに成果は無い、という一番もったいない終わり方になる。
 *
 * 待っている最中に届いたものは同じ回の余波とみなし、回数は増やさない。
 * 待ち時間だけは長いほうへ伸ばす（上流が Retry-After で長めを指示して
 * きた場合に、短いほうで先に投げ直さないため）。
 */
export function onRateLimited(
  state: RateLimitState,
  opts: { now: number; waitMs?: number; maxRounds?: number },
): RateLimitState {
  const { now, waitMs } = opts;
  const maxRounds = opts.maxRounds ?? RETRY_RATE_LIMIT_ROUNDS;
  const backoff =
    RATE_LIMIT_BACKOFF_MS[
      Math.min(state.rounds, RATE_LIMIT_BACKOFF_MS.length - 1)
    ];
  const wait = waitMs != null && waitMs > 0 ? waitMs : backoff;

  // 既に待っている最中なら、同じ回の余波
  if (now < state.pauseUntil) {
    return { ...state, pauseUntil: Math.max(state.pauseUntil, now + wait) };
  }
  if (state.rounds >= maxRounds) {
    return { ...state, exhausted: true };
  }
  return { pauseUntil: now + wait, rounds: state.rounds + 1, exhausted: false };
}

/**
 * レート制限以外の結果が1つ返ったときの、待ち直し回数の扱い。
 *
 * 回数は増える一方だったので、長い実行で分単位の制限に3回触れると、
 * 毎回きちんと待てていても試行を残して打ち切っていた。数えたいのは
 * 「待っても何も通らない」が続いた回数なので、何か1つでも決着したら
 * 数え直す。
 */
export function afterAttemptSettled(state: RateLimitState): RateLimitState {
  return { ...state, rounds: 0 };
}

/**
 * 同じ失敗が続いたら打ち切る本数。
 *
 * 認証・残高・パラメータのような直らないエラーは、投げるたびに同じ
 * 結果で返る。試行を消費しながら上限まで投げ続けるのは無駄で、
 * 「画像が揃う前に接続が切れた」型のエラーは上流側で課金されている
 * ことがある。拒否（画像の無い応答）は数えない——それを乗り越える
 * ための機能なので。
 */
export const RETRY_CONSECUTIVE_ERROR_LIMIT = 5;

/**
 * 結果は分かっているが、まだ数え上げに載っていない本数。
 *
 * 成功の数え上げ（state.successes++）は保存と画像の取り込みの後なので、
 * 上流の応答を読み切ってから1秒前後、その1本は「まだ結果の分からない
 * 1本」として枠に居座る。その窓で別の1本が決着すると、発射ループは
 * 古い成功数で枠を数え直し、必要より多く投げる——スマート生成が
 * 抑えたい超過そのもの。結果が届いた瞬間にここへ足し、数え上げが
 * 済んだら引く。
 */
export interface PendingTally {
  /** 結果が届いた（レート制限を除く）。 */
  known(kind: "success" | "refused" | "error" | "rate_limited"): void;
  /** 数え上げが済んだ。known と対で呼ぶ。 */
  counted(kind: "success" | "refused" | "error" | "rate_limited"): void;
  /** 届いているがまだ数えていない成功。 */
  successes(): number;
  /** 届いているがまだ数えていない試行（レート制限は含まない）。 */
  settled(): number;
}

export function createPendingTally(): PendingTally {
  let successes = 0;
  let settled = 0;
  return {
    known(kind) {
      if (kind === "rate_limited") return;
      settled++;
      if (kind === "success") successes++;
    },
    counted(kind) {
      if (kind === "rate_limited") return;
      settled--;
      if (kind === "success") successes--;
    },
    successes: () => successes,
    settled: () => settled,
  };
}

/**
 * 上流のエラー応答が、セーフティ判定による拒否か。
 *
 * 拒否を本文ではなく HTTP のエラーで返すモデルがある（400 と
 * "Your request was rejected by the safety system…" のような API の
 * 定型文）。エラーとして扱うと「同じ失敗が続いたら打ち切る」に掛かり、
 * 乗り越えるための機能が5回の拒否で止まる。拒否として扱えば、投げ直す
 * 対象になり、打ち切りの数え上げも戻る。
 *
 * 「拒否文の文言は見ない」という決まりの例外。ここで見るのはモデルの
 * 出力ではなく API 側の固定の文言と code で、言語も表現も揺れない。
 * 見誤ったときの害も有限で、拒否をエラーと読めば打ち切りが早まる
 * （直す前の状態）、エラーを拒否と読めば上限まで投げる（打ち切りを
 * 足す前の状態）。成功の判定（画像があるか）には触れない。
 *
 * 認証（401）・残高（402）・レート制限（429）は文言に何が書いてあっても
 * 拒否ではない。
 */
export const SAFETY_REJECTION_STATUSES = [400, 403, 422];
const SAFETY_REJECTION_PATTERN =
  /safety|moderation|content[ _-]?policy|usage[ _-]?policy|policy[ _-]?violation/i;

export function isSafetyRejection(status: number, text: string): boolean {
  if (!SAFETY_REJECTION_STATUSES.includes(status)) return false;
  return SAFETY_REJECTION_PATTERN.test(text);
}
