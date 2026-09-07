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
 *      コードを両方に使う。Poe は error.type、OpenRouter は 403 と
 *      metadata（reasons / flagged_input）で分かるが、元プロバイダの
 *      エラーが包まれて届く場合は決まり文句で補う。
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
  /** Poe の error.type / OpenRouter の error.metadata.error_type。 */
  type?: string | null;
  message?: string | null;
  /** OpenRouter が包む元プロバイダのエラー（metadata を文字列にしたもの）。 */
  raw?: string | null;
}

/**
 * セーフティ判定の手がかり。窓口の文書にある語（moderation / flagged /
 * guardrail）と、元プロバイダが使う語（safety / content policy）。
 * モデルの出力ではなく API の定型文に対して見る。
 */
const MODERATION_PATTERN =
  /moderat|flagged|guardrail|safety|content[ _-]?policy|usage[ _-]?policy|policy[ _-]?violation/i;

function looksModerated(f: UpstreamFailure): boolean {
  return MODERATION_PATTERN.test(
    [f.type ?? "", f.message ?? "", f.raw ?? ""].join("\n"),
  );
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

  if (status === 403) {
    // OpenRouter: 「insufficient permissions, guardrail block, or moderation
    // flag」。判定に掛かったときは metadata に reasons / flagged_input。
    // Poe: type が moderation_error。どちらも手がかりの語に含まれるので
    // 同じ検査で拾える（Poe だけの分岐を置いても結果は変わらなかった）
    return looksModerated(f) ? { kind: "refused" } : { kind: "fatal" };
  }

  if (status === 400 || status === 422) {
    // 文書上は「不正な依頼」だが、元プロバイダのセーフティ判定が
    // このコードで包まれて届くことがある（"rejected by the safety system"）
    return looksModerated(f) ? { kind: "refused" } : { kind: "fatal" };
  }

  // 401 認証・402 残高・404 モデル無し・413 大きすぎる、その他の 4xx
  if (status >= 400) return { kind: "fatal" };

  // 4xx でも 5xx でもない失敗は分からないので、待って投げ直す側に倒す
  return { kind: "transient" };
}
