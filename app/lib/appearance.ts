import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
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

/**
 * `<html>` の `dark` クラスを見張る係。図の数だけ作らず、1つを共有する。
 *
 * 以前は useIsDark ごとに MutationObserver を1つ作っていた。図が10個ある
 * 会話をダークで開けば監視も10個で、クラスが1回変わるたびに10回起きて
 * それぞれが自分の state を更新していた（監査 C-4）。見ているものは全員
 * 同じなので、監視は1つにして結果を配る。
 */
const darkListeners = new Set<() => void>();
let darkObserver: MutationObserver | null = null;

function subscribeDark(onChange: () => void): () => void {
  darkListeners.add(onChange);
  if (!darkObserver) {
    darkObserver = new MutationObserver(() => {
      for (const notify of [...darkListeners]) notify();
    });
    darkObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
  return () => {
    darkListeners.delete(onChange);
    // 誰も見ていなくなったら見張りも畳む（次に要るときに作り直す）
    if (darkListeners.size === 0) {
      darkObserver?.disconnect();
      darkObserver = null;
    }
  };
}

const readDark = (): boolean =>
  document.documentElement.classList.contains("dark");

/**
 * いまダークで表示しているか（`<html>` の `dark` クラス）を購読する。
 *
 * テーマの切替も端末設定の変化も、最終的には applyTheme が同じクラスを
 * 付け外しするので、そこだけを見ていれば両方に追従できる。
 *
 * 値はDOMから直に読む。useState(false) + effect で入れ直していたころは、
 * ダークで開いた図が必ず**2回**描かれていた——1回目は明るい配色で描き、
 * effect が true にしてもう一度。mermaid の描画は重く、図の数だけ重なる
 * （監査 C-4）。サーバー側では判断材料が無いので false を返す（この値を
 * 使うのは図の配色など、ブラウザでしか動かないものに限る）。
 */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeDark, readDark, () => false);
}
