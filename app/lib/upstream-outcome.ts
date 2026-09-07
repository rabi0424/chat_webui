/**
 * 上流の失敗を「どうするか」で分ける。
 *
 * このアプリはモデルに直接は話しかけず、OpenRouter と Poe という2つの
 * 窓口を通す。状態コードを決めるのは窓口なので、分け方の根拠は窓口の
 * 文書に置く（モデルごとの仕様ではない）:
 *   - OpenRouter: https://openrouter.ai/docs/api-reference/errors
 *   - Poe: https://creator.poe.com/docs/external-applications/openai-compatible-api
 *
 * 分けるのは3つ。
 *   - refused（断られた）: セーフティ判定。想定内なので投げ直し、
 *     試行回数に数え、成功率の見積もりにも入れる。
 *   - transient（一時的な不調）: 混雑・時間切れ・上流の障害。待ってから
 *     投げ直す。試行回数には数えず、率にも入れない（モデルが画像を
 *     出すかどうかとは関係ないため）。続けば打ち切る。
 *   - fatal（直らない）: 認証・残高・不正な依頼。投げ直しても同じなので
 *     その場で止める。
 *
 * 状態コードだけで決められないものが2つある。どの設計でも避けられない。
 *   1. 200 の中身に画像があるか（断りの文章も 200 で返る）。ここでは
 *      扱わず、呼ぶ側が中身を見る。
 *   2. 400/403/422 がセーフティ判定か、それ以外の誤りか。窓口が同じ
 *      コードを両方に使う。**文言では見分けない**——窓口やモデルが返す
 *      文言の一覧を知らないので、知っている語に当たったかどうかは根拠に
 *      ならない。区別できないものは投げ直す側に倒す。誤って止めると
 *      この機能そのものが使えず、誤って投げ直しても失うのは試行回数
 *      だけ（4xx は課金されずに即座に返る）。
 */

export type UpstreamProvider = "poe" | "openrouter";

export type UpstreamVerdict =
  | { kind: "refused" }
  | { kind: "transient" }
  | { kind: "fatal" };

export interface UpstreamFailure {
  provider: UpstreamProvider;
  /**
   * HTTP の状態。200 のあとに本文の中で届いたエラーなら、その中の code
   * （OpenRouter は元プロバイダの状態を入れてくる）。つながらなかった・
   * こちらで切った、のように状態そのものが無ければ null。
   */
  status: number | null;
  /**
   * Poe の error.type / OpenRouter の error.metadata.error_type と文言。
   * 判定には使わない（上の注記）。要約に出すために運ぶだけ。
   */
  type?: string | null;
  message?: string | null;
  raw?: string | null;
}

export function classifyUpstreamFailure(f: UpstreamFailure): UpstreamVerdict {
  const { status } = f;
  // 状態が無い: つながらない、ヘッダが来ない、途中で切れた、こちらで
  // 切った。上流の都合か回線の都合で、待てば通ることが多い
  if (status == null) return { kind: "transient" };

  // 両窓口とも: 429 は混雑、408 は上流側の時間切れ、5xx は上流の障害
  // （Poe の 500 provider_error・502 upstream_error・529 overloaded_error、
  // OpenRouter の 502 model down・503 no provider）。
  // Poe は「429/503 では Retry-After に従え」と書いている
  if (status === 429 || status === 408 || status >= 500) {
    return { kind: "transient" };
  }

  // 403: OpenRouter は「insufficient permissions, guardrail block, or
  // moderation flag」、Poe は moderation_error。400/422: 文書上は「不正な
  // 依頼」だが、元プロバイダのセーフティ判定がこのコードで包まれて届く
  // （"rejected by the safety system" が 400 で来た実例がある）。
  // どれもセーフティ判定と区別できないので、投げ直す側に倒す
  if (status === 400 || status === 403 || status === 422) {
    return { kind: "refused" };
  }

  // 401 認証・402 残高・404 モデル無し・413 大きすぎる、その他の 4xx。
  // セーフティ判定がこれらで届くことは文書に無い
  if (status >= 400) return { kind: "fatal" };

  // 4xx でも 5xx でもない失敗は分からないので、待って投げ直す側に倒す
  return { kind: "transient" };
}
