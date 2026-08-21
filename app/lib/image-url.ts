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
