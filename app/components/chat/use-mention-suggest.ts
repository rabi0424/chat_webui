/**
 * 宛先の候補を出す・選ぶ・閉じるの段取り。
 *
 * 同じ操作感を**2つの入力欄**で出す必要がある——下のコンポーザーと、
 * 送信済みの発言を書き直す編集欄。書き直しは「宛先を間違えた」「別の
 * ボットにも同じことを聞きたい」が動機になりやすく、そこで `@` が
 * 効かないのは、機能が無いのと変わらない。
 *
 * 片方に書いてもう片方へ写すと、次に直すときに**片方だけ**直る形の
 * 壊れ方をする（しかも画面には何も出ない）。開閉の判断・↑↓の位置・
 * キー操作をここへ1つだけ置き、入力欄の側は「本文をどう書き換えるか」
 * だけを持つ。
 */
import { useCallback, useState, type KeyboardEvent, type RefObject } from "react";
import { useEscapeToClose, useOutsideToClose } from "../../lib/dismiss";
import type { MentionBot, MentionState } from "../../lib/mention";

export function useMentionSuggest<B extends MentionBot>({
  text,
  mention,
  onPick,
  panelRef,
  anchorRef,
}: {
  /** 入力欄の本文（mention はこれを読んだ結果）。 */
  text: string;
  mention: MentionState<B>;
  onPick: (bot: B) => void;
  /** 候補の板。外側を押したかの判定に使う。 */
  panelRef: RefObject<HTMLElement | null>;
  /** 入力欄の枠。板の位置の基準であり、ここを押しても閉じない。 */
  anchorRef: RefObject<HTMLElement | null>;
}) {
  /**
   * Escape で閉じたときのメンション部分。ここが変わるまで開き直さない。
   *
   * 「閉じた」を真偽値だけで持つと、本文を打ち進めるたびに開き直って
   * しまう（閉じたのは候補であって、入力ではない）。逆に本文の変化で
   * 一切開き直さないと、`@` を打ち直しても二度と出てこない。
   */
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  /**
   * ↑↓ で選んでいる位置。「どのメンションに対する選択か」を一緒に持つ。
   *
   * 位置だけを持つと、打ち直して候補の並びが変わったときに前の位置が
   * 残り、Enter が**別のボット**を確定する。効果（useEffect）で戻すの
   * ではなく、描くときに見比べて捨てる。
   */
  const [picked, setPicked] = useState<{ of: string; index: number } | null>(
    null,
  );

  const mentionText = text.slice(0, mention.replaceEnd);
  /**
   * 候補を出すか。
   *
   * 宛先が決まっていない打ちかけのあいだと、決まってはいるが本文が
   * まだ無いあいだ（もっと長い名前へ打ち足せる）だけ出す。本文を
   * 打ち始めたら引っ込める。
   */
  const open =
    mention.present &&
    mention.candidates.length > 0 &&
    dismissedFor !== mentionText &&
    (mention.bot == null || mention.replaceEnd === text.length);

  /**
   * 既定でどれを選んでおくか。
   *
   * 打ちかけの断片があるとき（＝利用者が名前を絞り込んでいるとき）だけ
   * 先頭を選んでおき、Enter で確定できるようにする。`@media` のように
   * 名前と関係ない書き出しでは何も選ばない——ここで先頭を選んでおくと、
   * 送るつもりの Enter がボットの確定に化ける。
   */
  const defaultIndex = mention.fragment === "" ? -1 : 0;
  const activeIndex =
    picked && picked.of === mentionText ? picked.index : defaultIndex;
  const moveActive = (next: (i: number) => number) =>
    setPicked({ of: mentionText, index: next(activeIndex) });

  const close = useCallback(() => setDismissedFor(mentionText), [mentionText]);
  useEscapeToClose(open, close);
  useOutsideToClose(open, close, panelRef, anchorRef);

  /**
   * 候補が開いているあいだのキー操作。
   *
   * 拾ったときは true を返す——呼び出し側はそこで止め、入力欄本来の
   * 割り当て（コンポーザーの Enter = 送信、編集欄の Enter = 改行）へ
   * 進まない。
   */
  const handleKeyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false;
    const n = mention.candidates.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive((i) => (i + 1 + n) % n);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive((i) => (i <= 0 ? n - 1 : i - 1));
      return true;
    }
    // Tab は「補完」。どれも選んでいなければ先頭を採る。
    // Enter は選んでいるときだけ横取りする
    if (e.key === "Tab" || (e.key === "Enter" && activeIndex >= 0)) {
      e.preventDefault();
      onPick(mention.candidates[Math.max(activeIndex, 0)]);
      return true;
    }
    return false;
  };

  return { open, mentionText, activeIndex, handleKeyDown };
}
