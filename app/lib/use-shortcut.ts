/**
 * ショートカットの配り方。
 *
 * 拾うのは shell の1か所（document の keydown）。でも動かす相手は
 * 画面ごとに違う——検索はサイドバー、モデル選択は入力欄のチップ、
 * コピーは会話。props で下ろすと、そのためだけに何段も中継が要る。
 * 代わりに window の CustomEvent で配り、受けたい部品がここで購読する。
 * 受け手が居なければ何も起きない（ホームで「最後の応答をコピー」など）。
 */
import { useEffect, useRef } from "react";
import type { ShortcutId } from "./shortcuts";

const EVENT = "app:shortcut";

/** shell が呼ぶ。 */
export function dispatchShortcut(id: ShortcutId): void {
  window.dispatchEvent(new CustomEvent<ShortcutId>(EVENT, { detail: id }));
}

/**
 * そのショートカットが押されたら handler を呼ぶ。
 *
 * handler は毎回新しくてよい（ref に控えるので、購読は貼り替えない）。
 * `enabled` が false のあいだは無視する（畳まれているサイドバーなど）。
 */
export function useShortcut(
  id: ShortcutId,
  handler: () => void,
  enabled = true,
): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const onEvent = (e: Event) => {
      if ((e as CustomEvent<ShortcutId>).detail === id) ref.current();
    };
    window.addEventListener(EVENT, onEvent);
    return () => window.removeEventListener(EVENT, onEvent);
  }, [id, enabled]);
}

/** Mac か（表記を ⌘ にするか Ctrl にするか）。サーバー側では true。 */
export function isMacLike(): boolean {
  if (typeof navigator === "undefined") return true;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
