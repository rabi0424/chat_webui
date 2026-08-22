/**
 * 画面の裏で取りに行くもの（モデル一覧・為替）の取得。
 *
 * これまでは .catch(() => {}) で握りつぶしていた。失敗しても画面には
 * 何も出ず、理由も分からず、やり直す手立ても無い。モデル一覧が取れて
 * いないときは選べるモデルが0件になるので、**利用者からは「壊れている」
 * としか見えない**——しかも何が起きたかを知る方法が無い。
 *
 * 待てば直るもの（コールドスタート、上流の一時的な失敗、瞬断）は
 * 黙って何度か試す。それでも駄目なら理由を返し、呼び出し側が画面に
 * 出す。4xx は投げ直しても同じなので、待たずに諦める。
 */
export type Loaded<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 何回目の待ち時間か（ms）。1回目の再試行は素早く、以降は間を空ける。 */
const BACKOFF_MS = [400, 1_600];

export interface FetchJsonOptions {
  /** 試す回数（初回を含む）。 */
  attempts?: number;
  /** テストから待ち時間を飛ばすため。 */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/** その状態コードは、投げ直せば変わりうるか。 */
function worthRetrying(status: number): boolean {
  // 429 は「いま混んでいる」、5xx は上流かこちらの一時的な失敗。
  // それ以外の 4xx（404・400）は何度投げても同じ答えが返る
  return status === 429 || status >= 500;
}

export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<Loaded<T>> {
  const attempts = options.attempts ?? BACKOFF_MS.length + 1;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const doFetch = options.fetchImpl ?? fetch;

  let last = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
    try {
      const res = await doFetch(url);
      if (res.ok) {
        try {
          return { ok: true, value: (await res.json()) as T };
        } catch {
          // 本文が壊れている。投げ直しても同じものが返るとみなす
          return { ok: false, reason: "応答を読み取れませんでした" };
        }
      }
      last = `サーバーが ${res.status} を返しました`;
      if (!worthRetrying(res.status)) return { ok: false, reason: last };
    } catch {
      last = "つながりませんでした";
    }
  }
  return { ok: false, reason: last };
}
