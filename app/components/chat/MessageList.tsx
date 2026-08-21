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
import { type EditingState } from "./MessageEditor";

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
  actions,
  editing,
  setEditing,
  onSubmitEdit,
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
  actions: MessageActions;
  editing: EditingState | null;
  setEditing: Dispatch<SetStateAction<EditingState | null>>;
  onSubmitEdit: () => void;
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
      className="absolute inset-0 overflow-y-auto overscroll-contain"
    >
      <div
        ref={feedRef}
        className="chat-text mx-auto max-w-3xl px-4 pt-[calc(5rem+env(safe-area-inset-top))]"
        style={{ paddingBottom: footerHeight + 24 }}
      >
        {messages.length === 0 && (
          <div className="flex min-h-[60vh] items-center justify-center">
            {emptyState ?? (
              <p className="text-lg text-neutral-400 dark:text-neutral-500">
                モデルを選んでメッセージを送信
              </p>
            )}
          </div>
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
                    index={i}
                    editing={editing?.index === i ? editing : null}
                    setEditing={setEditing}
                    onSubmitEdit={onSubmitEdit}
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

        {!isStreaming &&
          !error &&
          lastMessage?.role === "assistant" &&
          lastMessage.status !== "error" && (
            <div className="mt-3">
              <button
                type="button"
                onClick={onRegenerate}
                className="rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              >
                ↻ 再生成
              </button>
            </div>
          )}

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
                className="rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent/10"
              >
                ↵ 応答を生成
              </button>
            </div>
          )}
      </div>
    </div>
  );
}
