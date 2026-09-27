/**
 * 一覧に並ぶメッセージが使う操作と状態。
 *
 * 1つの吹き出しは、分岐の行き来・引用・削除・再生成と、思ったより多くの
 * 入口を持つ。これらを props で配ると、ユーザー側と応答側の両方に同じ
 * 十数個を書き並べることになり、どれがその行に固有の値なのか（m と
 * index と isLast）が埋もれてしまう。共通の操作は文脈から取る。
 *
 * 文脈の値が変わると、それを読む吹き出しは memo を越えて全部描き直される。
 * だからここには「変われば全行の見た目が変わるもの」だけを置く。
 */
import { createContext, useContext } from "react";
import type { UiAttachment } from "../../lib/types";
import type { BotRow } from "../../lib/db.server";
import type { ModelInfo } from "../../lib/openrouter.server";

export interface MessageActions {
  /** 生成中。編集・分岐・削除の入口は閉じる（木が動いている最中なので）。 */
  isStreaming: boolean;
  /** 削除の選択モード。null なら通常表示。 */
  selecting: Set<string> | null;
  /** 選択の付け外し。id が無いメッセージ（保存前）は無視される。 */
  toggleSelect: (id: string | undefined) => void;
  /** 選択モードに入り、その1件だけを選ぶ。 */
  startSelect: (id: string) => void;

  /*
   * 「末尾の位置」はここに置かない。文脈の値が変わると、memo していても
   * 読んでいる吹き出しが**全部**描き直される。末尾の位置は発言が1つ
   * 増えるたびに変わるのに、それで見た目が変わるのは前後の2行だけ。
   * 行ごとの値（isLast）として一覧から props で渡す。
   */
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
 * 編集欄だけが使うもの（`@ボット名` の候補と、添えるモデル名）。
 *
 * 渡し口は props ではなく文脈にする——一覧 → ユーザーの吹き出し →
 * 編集欄と3段そのまま運ぶことになり、その行に固有の値が埋もれる。
 *
 * ただし上の操作一式とは**別の文脈**にする。ボットの一覧はシェルの
 * 読み込み結果で、サイドバーの更新（revalidate）のたびに中身が同じでも
 * 別の配列になる。同じ文脈に入れると、そのたびに全吹き出しが描き直され
 * ていた。ここを読むのは開いている編集欄1つだけなので、描き直しも
 * そこで止まる。
 */
export interface EditorOptions {
  /** 宛先にできるボット（`@ボット名` の候補）。 */
  bots: BotRow[];
  /** 候補と宛先に添えるモデル名を引くため。 */
  models: ModelInfo[];
}

const EditorOptionsContext = createContext<EditorOptions | null>(null);

export const EditorOptionsProvider = EditorOptionsContext.Provider;

export function useEditorOptions(): EditorOptions {
  const value = useContext(EditorOptionsContext);
  if (!value) {
    throw new Error("メッセージ一覧の外で編集欄を描こうとしています");
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
