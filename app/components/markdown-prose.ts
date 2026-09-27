/**
 * 本文を囲む枠のクラス。塊に分けて描くときも同じ枠に入れる。
 *
 * 描画の本体（MarkdownRenderer）から切り離してあるのは、枠だけ欲しい側
 * ——素のテキストの本文（PlainMessages）や、読み込みを待つあいだの代わり
 * ——が、これのために重い道具立てまで引き込まないようにするため。
 * 本体と同じ場所に置いていたころは、クラス名の文字列1つのために KaTeX も
 * 強調表示もサーバーのバンドルへ入っていた。
 */

/*
 * 見出しと行送りはチャット向けに詰める。
 *
 * typography の既定は「文書」の組版で、h1 が本文の 2.25 倍（iPhone で
 * 40px）、h2 の上に 54px の余白、行送り 1.75。会話は文書ではなく発言
 * なので、見出しは本文の 1.35 / 1.2 / 1.05 倍に、行送りは 1.65 に
 * 寄せる（ChatGPT / Claude の iOS アプリと同じ程度。監査 D-2）。
 */
const PROSE_CHAT =
  "prose-headings:font-semibold prose-headings:tracking-tight " +
  "prose-h1:text-[1.35em] prose-h1:leading-snug prose-h1:mt-[1.4em] prose-h1:mb-[0.5em] " +
  "prose-h2:text-[1.2em] prose-h2:leading-snug prose-h2:mt-[1.4em] prose-h2:mb-[0.5em] " +
  "prose-h3:text-[1.05em] prose-h3:mt-[1.2em] prose-h3:mb-[0.4em] " +
  "prose-p:leading-[1.65] prose-li:leading-[1.6] prose-li:my-1";

export function proseClassName(className?: string): string {
  return `prose prose-neutral dark:prose-invert max-w-none break-words prose-code:before:content-none prose-code:after:content-none ${PROSE_CHAT}${
    className ? ` ${className}` : ""
  }`;
}
