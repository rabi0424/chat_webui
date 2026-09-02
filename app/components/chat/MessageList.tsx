/**
 * やり取りの一覧。
 *
 * スクロールする箱と、その中に流れるメッセージ。末尾には状況に応じた
 * 誘い（再生成・応答を生成）が付く。
 *
 * 一覧の下側はコンポーザーが重なるので、その高さぶん余白を空けておく
 * （footerHeight）。固定値にすると、入力欄が複数行に伸びたときに
 * 最後のメッセージが隠れる。
 */
import { Fragment, type ReactNode, type RefObject, type Dispatch, type SetStateAction } from "react";
import type { UiMessage } from "../../lib/types";
import { ContextBoundaryLine } from "./message-parts";
import { MessageProvider, type MessageActions } from "./message-context";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { PlainMessages } from "./PlainMessages";
import { type EditingState } from "./MessageEditor";
import { conversationLanguage } from "../../lib/content-language";
import { IconArrowTurnDownLeft } from "../icons";

/**
 * 削除選択モードでコンテキストクリアを指す印。
 *
 * 選択の集合にはメッセージIDが入るので、境界線はこの接頭辞を付けて
 * 区別する（メッセージIDはUUIDなので衝突しない）。境界線もメッセージと
 * 同じように選んで削除ボタンで消せるようにするための仕掛け。
 */
export const BOUNDARY_SELECT_PREFIX = "boundary:";

export function MessageList({
  messages,
  visibleMessages,
  hiddenCount,
  bodyDeferred,
  actions,
  editing,
  setEditing,
  onSubmitEdit,
  onSaveEdit,
  onAddEditFiles,
  editFileInputRef,
  error,
  onRegenerate,
  onGenerateFromLast,
  emptyState,
  scrollRef,
  feedRef,
  onScroll,
  footerHeight,
}: {
  messages: UiMessage[];
  /** 実際に描くぶん（古い分を省いているときは messages より短い）。 */
  visibleMessages: UiMessage[];
  /** 省いた件数。messages 上の位置に戻すのに使う。 */
  hiddenCount: number;
  /**
   * まだ本文を1件も描いていない段か（サーバー描画とハイドレーション直後）。
   *
   * `visibleMessages.length === 0` から察することもできるが、そうすると
   * 「会話が空」と見分けが付かず、片方の意味が変わったときに黙ってずれる。
   */
  bodyDeferred: boolean;
  actions: MessageActions;
  editing: EditingState | null;
  setEditing: Dispatch<SetStateAction<EditingState | null>>;
  onSubmitEdit: () => void;
  onSaveEdit: () => void;
  onAddEditFiles: (files: File[]) => void;
  editFileInputRef: RefObject<HTMLInputElement | null>;
  /** 生成そのものが失敗したときの帯（メッセージ単位の失敗とは別）。 */
  error: string | null;
  onRegenerate: () => void;
  onGenerateFromLast: () => void;
  /** 会話が空のときに出すもの。無ければ既定の一言。 */
  emptyState?: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  feedRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  footerHeight: number;
}) {
  const { isStreaming, selecting, toggleSelect } = actions;
  const lastMessage = messages[messages.length - 1];

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      /*
        横には動かさない。中身が右へはみ出しても（吹き出し・長い一行）
        フィードごと横に滑るのではなく、その要素の中で収める。
      */
      className="absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain"
    >
      <div
        ref={feedRef}
        /*
          やり取りの言語を、画面まわり（日本語）と区別して宣言する。
          `<html lang>` と同じ判定を使うので、宣言が2箇所で食い違うことはない。
          これが無いと、英語の会話の中に混じった日本語のボタン
          （「↻ 再生成」など）まで英語だと言っていることになる。
        */
        lang={conversationLanguage(messages)}
        className="chat-text mx-auto max-w-3xl px-4 pt-[calc(5rem+env(safe-area-inset-top))]"
        style={{ paddingBottom: footerHeight + 24 }}
      >
        {messages.length === 0 && (
          <div className="flex min-h-[60vh] items-center justify-center">
            {emptyState ?? (
              <p className="text-lg text-ink-3">
                モデルを選んでメッセージを送信
              </p>
            )}
          </div>
        )}
        {/*
          本物の描画が始まる前に、本文を素のテキストのまま置いておく。
          これが無いと、読み込みが終わった時点の文書に本文が1文字も無く、
          Safari が言語を数えられずに翻訳を出さない（PlainMessages）。
        */}
        {bodyDeferred && messages.length > 0 && (
          <PlainMessages messages={messages} />
        )}
        <MessageProvider value={actions}>
          <div className="space-y-6">
            {visibleMessages.map((m, vi) => {
              const i = vi + hiddenCount;
              const body =
                m.role === "user" ? (
                  <UserMessage
                    key={m.id ?? `u${i}`}
                    m={m}
                    // 編集中かどうかはIDで見る。添字で見ていたころは、
                    // 枝を切り替えた先の同じ位置の発言に編集欄が
                    // 付き替わっていた（監査 C-2）
                    editing={editing?.id === m.id ? editing : null}
                    setEditing={setEditing}
                    onSubmitEdit={onSubmitEdit}
                    onSaveEdit={onSaveEdit}
                    onAddEditFiles={onAddEditFiles}
                    editFileInputRef={editFileInputRef}
                  />
                ) : (
                  <AssistantMessage key={m.id ?? `a${i}`} m={m} index={i} />
                );
              // 境界線はメッセージの「後ろ」に置く。Fragment なので
              // 一覧の space-y はメッセージと同じ間隔のまま効く
              const boundaryKey = BOUNDARY_SELECT_PREFIX + m.id;
              return m.contextBoundary ? (
                <Fragment key={`w${m.id ?? i}`}>
                  {body}
                  <ContextBoundaryLine
                    selecting={selecting != null && m.id != null}
                    selected={selecting?.has(boundaryKey) ?? false}
                    onToggle={() => toggleSelect(boundaryKey)}
                  />
                </Fragment>
              ) : (
                body
              );
            })}
          </div>
        </MessageProvider>

        {error && (
          <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            <span className="break-all">{error}</span>
            <button
              type="button"
              onClick={onRegenerate}
              className="shrink-0 rounded-lg border border-red-300 px-3 py-1 hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900"
            >
              再試行
            </button>
          </div>
        )}

        {/*
          末尾の応答の「再生成」は、その応答の操作列（AssistantMessage）に
          入っている。ここに別の行として置いていたころは、専用の行が
          1つぶん余計に伸びていた。
        */}

        {/* 分岐直後・応答削除後など、最後尾がユーザーメッセージのとき */}
        {!isStreaming &&
          !error &&
          !selecting &&
          lastMessage?.role === "user" &&
          lastMessage.id && (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={onGenerateFromLast}
                className="flex items-center gap-1.5 rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent/10"
              >
                <IconArrowTurnDownLeft className="h-3.5 w-3.5" />
                応答を生成
              </button>
            </div>
          )}
      </div>
    </div>
  );
}
