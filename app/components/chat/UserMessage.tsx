/**
 * こちらが送ったメッセージ。
 *
 * 右寄せの吹き出しに本文と添付を出し、下に操作を並べる。編集中は
 * 吹き出しごと MessageEditor に差し替わる（その場で書き直す形）。
 */
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { UiMessage } from "../../lib/types";
import { Markdown } from "../Markdown";
import { IconPencil, IconTrash } from "../icons";
import { BranchPager, CopyButton, MessageImages } from "./message-parts";
import { MessageEditor, type EditingState } from "./MessageEditor";
import { selectionClassOf, useMessageActions } from "./message-context";

export function UserMessage({
  m,
  index,
  editing,
  setEditing,
  onSubmitEdit,
  onAddEditFiles,
  editFileInputRef,
}: {
  m: UiMessage;
  index: number;
  /** この位置を編集中なら中身が入る。他の行を編集中なら null。 */
  editing: EditingState | null;
  setEditing: Dispatch<SetStateAction<EditingState | null>>;
  onSubmitEdit: () => void;
  onAddEditFiles: (files: File[]) => void;
  editFileInputRef: RefObject<HTMLInputElement | null>;
}) {
  const {
    isStreaming,
    selecting,
    toggleSelect,
    startSelect,
    switchBranch,
    fork,
    openImage,
  } = useMessageActions();
  const selectable = selecting != null && m.id != null;
  const iconButton =
    "rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 dark:group-hover/msg:text-neutral-500";

  return (
    <div
      className={`group/msg ${selectionClassOf(selecting, m.id)}`}
      onClick={selectable ? () => toggleSelect(m.id) : undefined}
    >
      {editing ? (
        <MessageEditor
          editing={editing}
          setEditing={setEditing}
          onSubmit={onSubmitEdit}
          onAddFiles={onAddEditFiles}
          fileInputRef={editFileInputRef}
        />
      ) : (
        <>
          {m.attachments && m.attachments.length > 0 && (
            <MessageImages attachments={m.attachments} onOpen={openImage} />
          )}
          {m.content && (
            <div className="flex justify-end">
              <div className="max-w-[85%] min-w-0 [overflow-wrap:anywhere] rounded-3xl rounded-br-lg bg-accent px-4 py-2.5 text-accent-fg">
                {/*
                  貼り付けた表やコードがそのまま読める形で残るよう、
                  入力もマークダウンとして描く。吹き出しの中は
                  アクセント色に載るので、prose の配色は使わず
                  文字色を継いで見出しや線だけを整える（.chat-bubble）。
                */}
                <Markdown diagrams={false} className="chat-bubble">
                  {m.content}
                </Markdown>
              </div>
            </div>
          )}
          {!selecting && (
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <BranchPager
                message={m}
                disabled={isStreaming}
                onSwitch={switchBranch}
              />
              {m.content && <CopyButton text={m.content} />}
              {m.id && !isStreaming && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setEditing({
                        index,
                        text: m.content,
                        attachments: m.attachments ?? [],
                        uploads: 0,
                      })
                    }
                    aria-label="編集して再送信"
                    title="編集して再送信（分岐を作成）"
                    className={iconButton}
                  >
                    <IconPencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => fork(m.id!)}
                    title="ここから分岐（独立した新しい会話を作成）"
                    className="rounded px-1.5 py-0.5 text-xs text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 dark:group-hover/msg:text-neutral-500"
                  >
                    ⑂ ここから分岐
                  </button>
                  <button
                    type="button"
                    onClick={() => startSelect(m.id!)}
                    aria-label="削除"
                    title="メッセージを削除（選択モードへ）"
                    className="rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-red-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-red-400 dark:group-hover/msg:text-neutral-500"
                  >
                    <IconTrash className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
