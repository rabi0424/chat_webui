import { useEffect, useLayoutEffect } from "react";
import { syncAccent } from "./accent";
import { syncChatFontSize } from "./chat-font";
import { syncTheme } from "./theme";

/**
 * 描き直しの直後に貼り直したいので、描画前に走る層で当てる。
 * サーバーでは効果が無いうえ警告になるため、ブラウザでだけ layout 側を使う。
 */
const useIsomorphicLayoutEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

/**
 * 端末ごとの見た目（テーマ・アクセント色・文字サイズ）を、保存値どおりに
 * DOMへ貼り直し続ける。
 *
 * これらは <html> の class / data-accent / style として持っている。最初の
 * 適用は <head> のインラインスクリプトが行うが、その結果は「Reactが描いた
 * 属性」ではないため、Reactが文書を描き直したときにまとめて消える。
 * ハイドレーションがどこかで食い違うと（サーバーとクライアントで秒数や
 * 日付がずれる等）Reactは server HTML を捨てて描き直すので、これが起きると
 * ダークモードが勝手に解除されたように見える——設定はダークのままなのに
 * 画面だけ明るい、という状態になる。
 *
 * 直す合図がどこにも無いとそのままなので、
 * - ハイドレーション直後（描き直された場合の復旧）
 * - bfcache からの復帰・アプリを前面に戻したとき（PWA）
 * - 端末の外観設定が変わったとき（「端末に合わせる」の追従）
 * のたびに保存値から貼り直す。読むだけなので保存値は書き換わらない。
 */
export function useAppearanceSync(): void {
  useIsomorphicLayoutEffect(() => {
    const sync = () => {
      syncTheme();
      syncAccent();
      syncChatFontSize();
    };
    sync();

    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", syncTheme);
    window.addEventListener("pageshow", sync);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      media.removeEventListener("change", syncTheme);
      window.removeEventListener("pageshow", sync);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
