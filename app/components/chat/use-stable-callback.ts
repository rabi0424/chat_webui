import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * 同一性が変わらず、呼ぶと常に最新の描画の関数へ届く関数。
 *
 * メッセージ一覧を memo で包んでも、親（Chat）が描画のたびに作り直す
 * 関数を渡していると毎回「別物」になり、結局一覧ごと描き直される。
 * ⚙パネルの開け閉めや値の変更でも会話の全吹き出しを描き直していて、
 * 長い会話ではパネルの操作がもっさりしていた。
 *
 * 描画中に呼ぶ関数（戻り値で見た目が変わるもの）には使わないこと。
 * 同一性が変わらないので、中身が変わっても memo の側は描き直さない。
 */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
