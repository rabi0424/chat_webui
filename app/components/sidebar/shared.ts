/**
 * サイドバーの行と本体で共有する小物。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { cancelPrefetch, prefetchChat } from "../../lib/chat-cache";

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
 * 行の要素 → 会話ID。監視は1つを全行で使い回すので、届いた要素から
 * どの会話かを引く。
 */
const watched = new Map<Element, string>();
let sharedObserver: IntersectionObserver | null = null;

/**
 * 全行で1つの監視。
 *
 * 以前は行ごとに IntersectionObserver を作り、最初に見えた時点で外して
 * いた。200行なら監視が200個で、しかも一度見えた行は二度と先読みされない
 * ——写しが古くなって捨てられた後は、押すたびにサーバーを待っていた。
 * 1つにまとめ、行が画面に入るたびに頼む（取得済みで新しければ
 * prefetchChat が何もしない）。出たら、まだ投げていない分は取り下げる。
 */
function observer(): IntersectionObserver {
  if (sharedObserver) return sharedObserver;
  sharedObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const id = watched.get(e.target);
      if (!id) continue;
      if (e.isIntersecting) prefetchChat(id);
      else cancelPrefetch(id);
    }
  });
  return sharedObserver;
}

/**
 * 会話リンクが画面に入ったら、その会話の中身を先読みする。
 * 指やポインタが乗ったとき・キーボードで移ったときは、並んでいる
 * 先読みより先に取る（押される見込みがいちばん高い）。
 * map の中ではフックを呼べないため、行のコンポーネント側で使う。
 */
export function usePrefetchOnVisible(id: string) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = observer();
    watched.set(el, id);
    io.observe(el);
    const intent = () => prefetchChat(id, { intent: true });
    el.addEventListener("pointerenter", intent);
    el.addEventListener("focusin", intent);
    el.addEventListener("touchstart", intent, { passive: true });
    return () => {
      io.unobserve(el);
      watched.delete(el);
      cancelPrefetch(id);
      el.removeEventListener("pointerenter", intent);
      el.removeEventListener("focusin", intent);
      el.removeEventListener("touchstart", intent);
    };
  }, [id]);
  return ref;
}
