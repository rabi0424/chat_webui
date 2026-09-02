/**
 * サイドバーの行と本体で共有する小物。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { prefetchChat } from "../../lib/chat-cache";

/** Tailwind の md 未満（iPhone の幅）。 */
const NARROW_QUERY = "(max-width: 767px)";

/**
 * いま iPhone の幅か。サーバー側では false（md 以上として描く）。
 *
 * 「…」メニューの出し方（ポップオーバーかシートか）を決めるのに使う。
 * メニューは開いた後にしか描かれないので、サーバーとの食い違いは起きない。
 */
export function useIsNarrow(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia(NARROW_QUERY);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/**
 * 常設の「お気に入り」フォルダを指す印。
 * 実体のフォルダではないので、実在しないIDを当てて区別する。
 */
export const FAVORITES_ID = "__favorites__";

/**
 * 会話リンクが画面に入ったら、その会話の中身を先読みする。
 * map の中ではフックを呼べないため、行のコンポーネント側で使う。
 */
export function usePrefetchOnVisible(id: string) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        prefetchChat(id);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [id]);
  return ref;
}
