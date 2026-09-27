/**
 * Markdown の描画の本体（`components/MarkdownRenderer.tsx`）の読み込み口。
 *
 * `.client.ts` にしてあるのは、サーバー側のビルドから完全に締め出すため
 * （`mermaid.client.ts` と同じ）。動的 import のままだと、呼ばれないにしても
 * Workers のバンドルには本体とその依存（KaTeX・強調表示・parse5 ……）が
 * 丸ごと入る。サーバーは本文を Markdown として描かない（Chat の
 * renderStage）ので、サーバー側では空の module に差し替えられて構わない。
 *
 * **ここにはサーバーでも呼ばれうるものを置かないこと。** 差し替えられた
 * 先では export が全部 undefined になる。呼んでよいのはブラウザの
 * useEffect の中だけ（`components/Markdown.tsx`）。
 */
export type MarkdownRenderer = typeof import("../components/MarkdownRenderer");

export function importMarkdownRenderer(): Promise<MarkdownRenderer> {
  return import("../components/MarkdownRenderer");
}
