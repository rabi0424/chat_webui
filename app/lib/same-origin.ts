/**
 * 別のサイトから書き換えの要求が飛んでくるのを止める。
 *
 * このアプリの API は Cookie（Cloudflare Access のセッション）で守られて
 * いる。Cookie は「どのサイトから出た要求か」に関わらず付いていくので、
 * 他所のページに置いた <form> や fetch からでも、ログイン済みの
 * ブラウザなら通ってしまう——会話の削除もフォルダの削除も、リンクを
 * 踏ませるだけで起こせる状態だった。
 *
 * 書き換え（GET と HEAD 以外）のときだけ、要求元が自分自身かを見る。
 *
 * 見るのは Sec-Fetch-Site。ブラウザが付ける値で、ページ側からは
 * 書き換えられない（Origin と違って「無い」を装うこともできない）。
 * 対応していない環境のために Origin も見て、どちらも無い場合だけ通す
 * ——curl や別のアプリからの正当な呼び出しを閉め出さないため。
 * ブラウザから来た要求には必ずどちらかが付く。
 */

/** 書き換えを伴うメソッドか。 */
export function isMutating(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

/**
 * その要求を受け付けてよいか。
 *
 * @param request 受け取った要求
 * @returns 受け付けてよければ null、断るなら理由
 */
export function crossSiteReason(request: Request): string | null {
  if (!isMutating(request.method)) return null;

  const site = request.headers.get("Sec-Fetch-Site");
  if (site != null) {
    // same-origin: 同じ生成元。none: アドレス欄への直接入力やブックマーク
    if (site === "same-origin" || site === "none") return null;
    return `Sec-Fetch-Site: ${site}`;
  }

  const origin = request.headers.get("Origin");
  if (origin == null) {
    // ブラウザ以外からの呼び出し。Cookie も自動では付かない
    return null;
  }
  try {
    if (new URL(origin).origin === new URL(request.url).origin) return null;
  } catch {
    return "Origin が壊れています";
  }
  return `Origin: ${origin}`;
}
