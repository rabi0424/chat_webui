/**
 * サイドバーの行と本体で共有する小物。
 */
import { useEffect, useRef } from "react";
import { prefetchChat } from "../../lib/chat-cache";

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
