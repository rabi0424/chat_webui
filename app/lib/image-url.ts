/**
 * 応答の中に出てくる URL が画像を指しているかの判定。
 *
 * 生成の本体（generation.server.ts）から切り出してある。あちらは
 * cloudflare:workers を読むので Workers の外からは触れないが、
 * この判定は URL を見るだけの純粋な処理でしかない。
 */

/**
 * その URL は画像を指していそうか。
 *
 * 見るのはパスの末尾だけ。文字列の末尾で判定していたころは
 * `?ref=x.png` のようにクエリが拡張子で終わるものまで拾い、画像で
 * ないページを取りに行っていた。1件につき外部リクエストを1つ使うので、
 * 上限のある枠（無料プランでは1回の実行あたり50件）が無駄に減る。
 */
export function looksLikeImageUrl(raw: string): boolean {
  try {
    return /\.(png|jpe?g|webp|gif)$/i.test(new URL(raw).pathname);
  } catch {
    return false;
  }
}

/**
 * 取りに行ってよい URL か。
 *
 * ここへ来る URL は**モデルが本文に書いたもの**で、こちらが決めた値では
 * ない。上流が細工された応答を返せば、その URL をサーバーが取りに行く
 * ことになる。Workers から社内網が見えるわけではないが、宛先を選べる
 * 取得口を、外から文字列で指定できる形で開けておく理由も無い。
 *
 * - 仕組みは http/https だけ（file: や data: は別の経路で扱う）
 * - 自分自身・私設アドレス・リンクローカル（クラウドのメタデータが
 *   居る 169.254.169.254 を含む）は宛先にしない
 */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
]);

/** 私設・リンクローカルのアドレスか。 */
function isPrivateAddress(host: string): boolean {
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".internal")) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // リンクローカル（メタデータ）
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  // IPv6 のループバック・ユニークローカル
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
  if (/^fe80:/.test(bare)) return true;
  return false;
}

export function isFetchableImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return !isPrivateAddress(url.hostname.toLowerCase());
}
