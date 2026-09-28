/**
 * 見出しの書体（Zen Kaku Gothic New）の読み込み。
 *
 * 以前は `<head>` に `<link rel="stylesheet">` で直に置いていた。これは
 * **描画を止める**——外部の CSS が届くまで、ブラウザは画面を1文字も
 * 描かない。しかもこの CSS は大きい（日本語の書体は文字の範囲ごとに
 * 分けて配られるので、iPhone の UA で 240 個余りの @font-face、約 226KB）
 * うえに、別のホストなので名前解決と TLS の往復が先に挟まる。
 * 見出しにしか使わない書体のために、画面全体の最初の描画を待たせていた。
 *
 * そこで、描いてから（ハイドレーションのあとに）スクリプトで `<link>` を
 * 差し込む。届くまでの見出しはシステム書体で描かれ、届いたら差し替わる
 * （display=swap。直に置いていたころも書体のファイル自体は後から届いて
 * いたので、差し替わる見え方は変わらない）。
 *
 * よくある `<link rel="preload" onload="this.rel='stylesheet'">` や
 * `media="print" onload=…` の形は使えない。CSP で script-src を nonce と
 * ハッシュに絞っていて、属性に書いたイベントハンドラは実行されない
 * （'unsafe-hashes' を足す手もあるが、そのためだけに口を広げたくない）。
 *
 * 自前で書体を配る（字を絞ったファイルを置く）形も考えたが、見出しには
 * 会話の題やエラーの文言のような**任意の文字**が入る。絞った字に無い字は
 * そこだけ別の書体で描かれ、題の中で書体が混ざる。文字の範囲ごとに
 * 分けて必要な分だけ取りに行く仕組みは Google Fonts がすでに持っているので、
 * それをそのまま使い、止めていた描画だけを外した。
 */

/** 書体の CSS。CSP の style-src はこの URL のオリジンを許す（csp.ts）。 */
export const DISPLAY_FONT_CSS_URL =
  "https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@500;700&display=swap";

/** 書体のファイルの置き場。CSP の font-src はここを許す（csp.ts）。 */
export const DISPLAY_FONT_FILE_ORIGIN = "https://fonts.gstatic.com";

/** CSS の取得先のオリジン（preconnect と CSP で使う）。 */
export const DISPLAY_FONT_CSS_ORIGIN = new URL(DISPLAY_FONT_CSS_URL).origin;

/**
 * 書体の CSS を差し込む。何度呼んでも1本だけ。
 *
 * 開発時の StrictMode は effect を2回走らせるし、Layout はエラー画面でも
 * 描かれる。そのたびに `<link>` が増えると、同じ CSS を何度も解釈させる
 * ことになるので、印を付けて重複を避ける。
 */
export function loadDisplayFont(doc: Document = document): void {
  if (doc.head.querySelector("link[data-display-font]")) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = DISPLAY_FONT_CSS_URL;
  link.dataset.displayFont = "";
  doc.head.appendChild(link);
}
