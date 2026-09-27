/**
 * 本文を Markdown として描く入口。描画の本体は**あとから読み込む**。
 *
 * 本体（`MarkdownRenderer.tsx`：記法の解釈・KaTeX・強調表示・生HTMLの
 * 消毒）はビルド後で 900KB（gzip 270KB）ほどあり、静的に import していた
 * ころは最初の読み込みで落とす JS 1.3MB の7割を占めていた。本文を1件も
 * 描かないホーム（PWA の起動先）でも、それを全部落として評価するまで
 * 画面が動かなかった。サーバーのバンドルにも入り、API のポーリングを含む
 * 全部の呼び出しで、冷えた起動のたびに評価されていた——サーバーは本文を
 * Markdown として描かない（Chat の renderStage）にもかかわらず。
 *
 * 読み込みを始めるのは次のどちらか早いほう:
 *  - 本文がひとつでも画面に出たとき（その場で取りに行く）
 *  - 会話の画面が出て手が空いたとき（`useMarkdownReady`。ホームで
 *    最初の発言を送る前に届いているように）
 *
 * 届くまでのあいだは、記法を解釈しないまま段落に入れた本文を出す
 * （PlainMessages と同じ形）。空白にすると画面が一瞬抜けて見え、何も
 * 無い高さから本物へ飛ぶ。枠のクラスは本物と共有しているので、入れ
 * 替わるときの飛びは記法のぶんだけで済む。
 *
 * **React.lazy + Suspense を使わない理由**: ハイドレーション中に
 * サスペンドすると、サーバーの HTML と食い違ったとき境界の中身が作り
 * 直される。ここは useSyncExternalStore の getServerSnapshot で
 * 「ハイドレーション中はまだ無い」と決め打ちにして、サーバーと必ず
 * 同じもの（素の段落）を描いてから本物へ移る。いまはサーバーで本文を
 * 描かないので実際には通らないが、描くようになった日に黙って崩れない。
 */
import {
  memo,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  importMarkdownRenderer,
  type MarkdownRenderer,
} from "../lib/markdown-renderer.client";
import { proseClassName } from "./markdown-prose";
import { paragraphs } from "./chat/PlainMessages";

// 枠だけ欲しい側はここからでも取れるようにしておく（中身は軽い）
export { proseClassName };

export type MarkdownBodyProps = {
  children: string;
  /** 新しく現れた語をふわりと出す（生成中の末尾だけに使う）。 */
  animate?: boolean;
  /** 本文の中の画像をタップしたとき（会話の中でだけ渡す）。 */
  onImageClick?: (src: string) => void;
  /** 本文がまだ伸びている最中か（図を描くのを待たせるのに使う）。 */
  streaming?: boolean;
  /** ```mermaid を図にしてよいか。false ならソースのまま見せる。 */
  diagrams?: boolean;
  /** すでに prepareMarkdown を通してあるか（塊に分けて渡すときに使う）。 */
  prepared?: boolean;
};

let renderer: MarkdownRenderer | null = null;
let loading: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

/**
 * 本体を取りに行く。何度呼んでも1回だけ。届いたら true。
 *
 * 取れなかったら（通信の途切れなど）次に呼ばれたときに取り直す。覚えた
 * ままにすると、一度の失敗でそのページのあいだずっと素の段落のままになる。
 * 失敗を投げ返さないのは、呼び手がどれも「待たずに始めるだけ」だから
 * （投げると、誰も受けない例外が毎回コンソールに出る）。
 */
export function preloadMarkdown(): Promise<boolean> {
  loading ??= importMarkdownRenderer().then(
    (m) => {
      renderer = m;
      for (const notify of listeners) notify();
      return true;
    },
    () => {
      loading = null;
      return false;
    },
  );
  return loading;
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

function useRenderer(): MarkdownRenderer | null {
  return useSyncExternalStore(
    subscribe,
    () => renderer,
    // サーバーとハイドレーション中は「まだ無い」。上の説明を参照
    () => null,
  );
}

/**
 * 本体が届いているか。届いた瞬間に一度だけ変わる。
 *
 * 呼んだ画面が出て手が空いたところで読み込みも始める。会話の画面は
 * これで、届いたとき（本文の高さが変わったとき）に最下部へ貼り直す。
 */
export function useMarkdownReady(): boolean {
  const ready = useRenderer() != null;
  useEffect(() => {
    if (renderer) return;
    // ホームでは本文がまだ無い。ハイドレーション直後の入力やタップと
    // 回線・CPU を取り合わないよう、手が空いてから取りに行く。
    // Safari には requestIdleCallback が無いので時間で代える
    const run = () => void preloadMarkdown();
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(run, 500);
    return () => clearTimeout(timer);
  }, []);
  return ready;
}

/**
 * 本体が届くまでの代わり。記法は解釈せず、段落に割って出すだけ。
 *
 * 伸びている塊（animate）は本物と同じく翻訳の対象から外す——届くまでの
 * あいだも中身は伸び続けて描き直されるので、訳に差し替えられた節点を
 * React が触って落ちる事情は同じ（MarkdownRenderer の
 * TRANSLATE_WHILE_GROWING）。
 */
function PlainBody({
  text,
  animate,
}: {
  text: string;
  animate: boolean;
}): ReactNode {
  return paragraphs(text).map((p, i) => (
    <p key={i} translate={animate ? "no" : undefined}>
      {p}
    </p>
  ));
}

/**
 * 枠を持たない本文。同じ枠の中に複数並べてよい（塊に分けて描くとき）。
 *
 * memo必須: 本体のパースが重く、ストリーミング中は親が毎チャンク再描画
 * される。本文が変わらない塊の描き直しをここで止める。
 */
export const MarkdownBody = memo(function MarkdownBody(
  props: MarkdownBodyProps,
) {
  const impl = useRenderer();
  useEffect(() => {
    if (!renderer) void preloadMarkdown();
  }, []);
  if (!impl) {
    return <PlainBody text={props.children} animate={!!props.animate} />;
  }
  return <impl.MarkdownBody {...props} />;
});

/** 本文ひとかたまり。 */
export const Markdown = memo(function Markdown({
  className,
  ...body
}: MarkdownBodyProps & { className?: string }) {
  return (
    <div className={proseClassName(className)}>
      <MarkdownBody {...body} />
    </div>
  );
});
