/**
 * mermaid 本体の読み込み口。
 *
 * `.client.ts` にしてあるのは、サーバー側のビルドから完全に締め出すため。
 * mermaid は依存（cytoscape・dagre・図の種類ごとの構文解析器）を合わせると
 * 7MB ほどあり、動的 import のままだと Cloudflare Workers のバンドルにも
 * 全部のチャンクが入ってしまう。実際に呼ぶのはブラウザの useEffect の中
 * だけなので、サーバー側は空の module に差し替えられて構わない。
 *
 * ブラウザ側では、最初に図が現れたときだけ取りに行き、以後は使い回す。
 */

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;

export function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}
