/**
 * 一覧に並ぶメッセージが使う操作と状態。
 *
 * 1つの吹き出しは、分岐の行き来・引用・削除・再生成と、思ったより多くの
 * 入口を持つ。これらを props で配ると、ユーザー側と応答側の両方に同じ
 * 十数個を書き並べることになり、どれがその行に固有の値なのか（m と
 * index だけ）が埋もれてしまう。共通の操作は文脈から取る。
 */
import { createContext, useContext } from "react";
import type { UiAttachment } from "../../lib/types";

export interface MessageActions {
  /** 生成中。編集・分岐・削除の入口は閉じる（木が動いている最中なので）。 */
  isStreaming: boolean;
  /** 削除の選択モード。null なら通常表示。 */
  selecting: Set<string> | null;
  /** 選択の付け外し。id が無いメッセージ（保存前）は無視される。 */
  toggleSelect: (id: string | undefined) => void;
  /** 選択モードに入り、その1件だけを選ぶ。 */
  startSelect: (id: string) => void;

  /** messages の末尾の位置。カーソルや再試行を出すかの判定に使う。 */
  lastIndex: number;
  /** 画像を出力するモデルか（本文が流れてこないので進捗の見せ方を変える）。 */
  isImageGeneration: (modelId: string | undefined) => boolean;
  /** 円換算のレート。null ならドルのまま出す。 */
  usdJpy: number | null;

  /** 兄弟の枝へ移る。 */
  switchBranch: (targetId: string) => void;
  /** ここまでを別の会話として切り出す。 */
  fork: (messageId: string) => void;
  /** 最後の応答をやり直す。 */
  regenerate: () => void;
  /** 拡大表示を開く。 */
  openImage: (url: string) => void;
  /** 生成された画像を入力欄の添付に移す。 */
  attachGeneratedImages: (attachments: UiAttachment[]) => void;
  /** 本文が伸びたぶん追従してスクロールする。 */
  followBottom: () => void;
}

const MessageContext = createContext<MessageActions | null>(null);

export const MessageProvider = MessageContext.Provider;

export function useMessageActions(): MessageActions {
  const value = useContext(MessageContext);
  if (!value) {
    throw new Error("メッセージ一覧の外で吹き出しを描こうとしています");
  }
  return value;
}

/**
 * 選択モードのときに吹き出しへ足す見た目。
 * 通常表示では空文字（余計な余白を作らない）。
 */
export function selectionClassOf(
  selecting: Set<string> | null,
  id: string | undefined,
): string {
  if (!selecting) return "";
  return `cursor-pointer rounded-xl px-2 py-1 -mx-2 ${
    id && selecting.has(id)
      ? "bg-accent/10 ring-1 ring-accent/50"
      : "hover:bg-neutral-50 dark:hover:bg-neutral-900"
  }`;
}
