/**
 * 送信済みメッセージを書き直す入力欄。
 *
 * 「編集して再送信」は元のメッセージを上書きせず、そこから分岐を作る
 * （元のやり取りは枝として残り、BranchPager で行き来できる）。そのため
 * 見た目も送信欄ではなく、その場に開く小さな箱にしている。
 *
 * 出口は2つ。「保存」は枝を作るだけで生成しない（文面を整えておいて、
 * モデルやパラメータを選んでから送りたいことがある）。「送信」は保存
 * してそのまま生成する。生成中は送信だけを閉じる——2本目の生成を
 * 同時に走らせない決まりだが、枝を作っておくことはできる。
 *
 * 添付は本文と同じく編集できる。既にある画像は外せて、新しく足すことも
 * できる——アップロードの最中は uploads に枚数が入り、その分だけ枠を
 * 先に見せる（何枚増えるのか分かるように）。
 */
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { UiAttachment } from "../../lib/types";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE as MAX_ATTACHMENTS,
} from "../../lib/constants";
import { isAcceptedImage } from "../../lib/image";
import { PROSE_INPUT } from "../../lib/ui";
import { IconPlus } from "../icons";

/** 編集中のメッセージ。index は messages の位置。 */
export interface EditingState {
  index: number;
  text: string;
  attachments: UiAttachment[];
  /** アップロード中の枚数。終わると attachments に移る。 */
  uploads: number;
}

export function MessageEditor({
  editing,
  setEditing,
  onSubmit,
  onSave,
  submitDisabled = false,
  onAddFiles,
  fileInputRef,
}: {
  editing: EditingState;
  setEditing: Dispatch<SetStateAction<EditingState | null>>;
  /** 保存して、そのまま生成する。 */
  onSubmit: () => void;
  /** 枝として保存するだけ（生成しない）。 */
  onSave: () => void;
  /** 生成中など、送信だけを閉じるとき。 */
  submitDisabled?: boolean;
  onAddFiles: (files: File[]) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
}) {
  const full = editing.attachments.length + editing.uploads >= MAX_ATTACHMENTS;
  const empty = !editing.text.trim() && editing.attachments.length === 0;
  const busy = editing.uploads > 0;
  return (
    <div className="rounded-2xl border border-accent/50 bg-neutral-50 p-3 dark:bg-neutral-900">
      {(editing.attachments.length > 0 || editing.uploads > 0) && (
        <div className="mb-2 flex flex-wrap gap-2">
          {editing.attachments.map((a) => (
            <div
              key={a.id}
              className="group/att relative h-16 w-16 overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-700"
              title={a.name ?? "画像"}
            >
              <img
                src={`/api/files/${a.id}`}
                alt={a.name ?? "添付画像"}
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                onClick={() =>
                  setEditing((prev) =>
                    prev
                      ? {
                          ...prev,
                          attachments: prev.attachments.filter(
                            (x) => x.id !== a.id,
                          ),
                        }
                      : prev,
                  )
                }
                aria-label="添付を削除"
                className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-xs text-white opacity-0 transition group-hover/att:opacity-100 focus:opacity-100 touch:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
          {Array.from({ length: editing.uploads }).map((_, n) => (
            <div
              key={`up${n}`}
              className="grid h-16 w-16 place-items-center rounded-xl border border-neutral-200 dark:border-neutral-700"
            >
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-accent" />
            </div>
          ))}
        </div>
      )}
      <textarea
        value={editing.text}
        onChange={(e) =>
          setEditing((prev) => (prev ? { ...prev, text: e.target.value } : prev))
        }
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.some(isAcceptedImage)) {
            e.preventDefault();
            onAddFiles(files);
          }
        }}
        rows={3}
        autoFocus
        translate="no"
        {...PROSE_INPUT}
        className="w-full resize-y bg-transparent outline-none"
      />
      <div className="mt-2 flex items-center gap-2 text-sm">
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_IMAGE_TYPES.join(",")}
          multiple
          hidden
          onChange={(e) => {
            onAddFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={full}
          aria-label="画像を追加"
          title="画像を追加"
          className="grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <IconPlus className="h-4.5 w-4.5" />
        </button>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="rounded-lg px-3 py-1.5 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={empty || busy}
            title={
              busy
                ? "画像をアップロード中…"
                : "送らずに枝として保存する（あとから送信できます）"
            }
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            保存
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={empty || busy || submitDisabled}
            title={
              busy
                ? "画像をアップロード中…"
                : submitDisabled
                  ? "生成中は送信できません（保存はできます）"
                  : "保存して生成する"
            }
            className="rounded-lg bg-accent px-3 py-1.5 text-accent-fg hover:bg-accent/85 disabled:opacity-30"
          >
            送信
          </button>
        </div>
      </div>
    </div>
  );
}
