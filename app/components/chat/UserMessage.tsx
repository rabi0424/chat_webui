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
import {
  MSG_DELETE_ACTION,
  MSG_ICON_ACTION,
  MSG_TEXT_ACTION,
} from "../../lib/ui";

export function UserMessage({
  m,
  editing,
  setEditing,
  onSubmitEdit,
  onSaveEdit,
  onAddEditFiles,
  editFileInputRef,
}: {
  m: UiMessage;
  /** この発言を編集中なら中身が入る。他の行を編集中なら null。 */
  editing: EditingState | null;
  setEditing: Dispatch<SetStateAction<EditingState | null>>;
  onSubmitEdit: () => void;
  /** 編集を枝として保存するだけ（生成しない）。 */
  onSaveEdit: () => void;
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
    followBottom,
  } = useMessageActions();
  const selectable = selecting != null && m.id != null;

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
          onSave={onSaveEdit}
          // 生成中は送信だけ閉じる（2本目を同時に走らせない）
          submitDisabled={isStreaming}
          onAddFiles={onAddEditFiles}
          fileInputRef={editFileInputRef}
        />
      ) : (
        <>
          {m.attachments && m.attachments.length > 0 && (
            <MessageImages
              attachments={m.attachments}
              /*
                選択モード中は開かない。行を選ぶつもりのタップで拡大表示
                まで開き、閉じたときには行も選ばれている（監査 C-8）。
                タップ自体は行の選択として通す。
              */
              onOpen={selecting ? () => {} : openImage}
              onLoad={followBottom}
            />
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
              <BranchPager message={m} onSwitch={switchBranch} />
              {m.content && <CopyButton text={m.content} />}
              {/*
                編集と分岐は生成中でも開ける。どちらも枝を作るだけで、
                生成そのものには触れない（編集の「送信」だけは、
                2本目の生成になるので生成中は閉じてある）。
                削除だけは閉じておく——走っている応答の親を消すと、
                書き込む先を失った生成が宙に浮く。
              */}
              {m.id && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setEditing({
                        // 位置ではなくIDで覚える。枝を切り替えても
                        // 別の発言へ付き替わらないように（監査 C-2）
                        id: m.id!,
                        text: m.content,
                        attachments: m.attachments ?? [],
                        uploads: 0,
                      })
                    }
                    aria-label="編集して再送信"
                    title="編集（保存だけ / 送信して分岐）"
                    className={MSG_ICON_ACTION}
                  >
                    <IconPencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => fork(m.id!)}
                    title="ここから分岐（独立した新しい会話を作成）"
                    className={MSG_TEXT_ACTION}
                  >
                    ⑂ ここから分岐
                  </button>
                  {!isStreaming && (
                    <button
                      type="button"
                      onClick={() => startSelect(m.id!)}
                      aria-label="削除"
                      title="メッセージを削除（選択モードへ）"
                      className={MSG_DELETE_ACTION}
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
