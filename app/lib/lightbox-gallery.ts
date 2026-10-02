/**
 * 会話の中で「開ける画像」を並び順どおりに拾う（拡大表示のまま隣へ移るため）。
 *
 * 画像は2つの入口から開く——添付（MessageImages）と本文の中の画像
 * （MarkdownImage）。本文の画像はマークダウンを描いて初めて URL が
 * 決まる（コードブロックの中は画像にならない、参照形式の `![][ref]` も
 * ある）ので、データからもう一度拾い直すと、描いたものと食い違う。
 * そこで押しどころに印（この属性）を付け、描かれた順に DOM から集める。
 * 印は「開ける」ときにだけ付ける——選択モードや思考プロセスの中の画像は
 * 押しても開かないので、払った先にも出さない。
 */
export const LIGHTBOX_SRC_ATTR = "data-lightbox-src";

/**
 * root の中の開ける画像の URL を、上から順に返す。
 *
 * 同じ URL は1つにまとめる。同じ画像が2箇所にあると（生成画像を添付に
 * 移して送り直したときなど）、払った先に同じ絵がもう一度出て、進んで
 * いないように見える。
 */
export function collectLightboxSources(root: HTMLElement | null): string[] {
  if (!root) return [];
  const seen = new Set<string>();
  for (const el of root.querySelectorAll(`[${LIGHTBOX_SRC_ATTR}]`)) {
    const src = el.getAttribute(LIGHTBOX_SRC_ATTR);
    if (src) seen.add(src);
  }
  return [...seen];
}
