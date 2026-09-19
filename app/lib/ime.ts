/**
 * IME の変換中・確定のキー入力か。
 *
 * 変換中の Enter は候補の確定であって送信ではない。`isComposing` を
 * 見れば済むはずだが、Safari（macOS / iOS）は `compositionend` を
 * keydown より**先に**出すため、確定の Enter は `isComposing === false`
 * で届く。その代わり `keyCode` が 229（IME が処理したキー）になる。
 * 片方だけ見ていると、iPhone で変換を確定した瞬間に書きかけの本文が
 * 送られる（監査 C-1）。
 */
export function isImeKeystroke(e: {
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return e.isComposing === true || e.keyCode === 229;
}
