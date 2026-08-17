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

export const RETRY_ENABLED_KEY = "retry";
export const RETRY_TARGET_KEY = "retryTarget";
export const RETRY_MAX_KEY = "retryMax";
export const RETRY_CONCURRENCY_KEY = "retryConcurrency";

export interface RetryConfig {
  /** ほしい成功応答の数。 */
  target: number;
  /** あきらめるまでの試行回数。 */
  maxAttempts: number;
  /** 同時に走らせる数。目標数を超えてもよい（超過分の成功も残す）。 */
  concurrency: number;
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
  // 試行回数と並列数は、未入力なら目標数と同じとみなす
  const maxAttempts = Math.min(
    Math.max(1, toInt(state[RETRY_MAX_KEY], target)),
    Math.max(1, Math.round(ceiling)),
  );
  const concurrency = Math.min(
    Math.max(1, toInt(state[RETRY_CONCURRENCY_KEY], target)),
    maxAttempts,
  );

  return { target, maxAttempts, concurrency };
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
