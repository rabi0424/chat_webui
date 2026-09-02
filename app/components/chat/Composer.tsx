/**
 * メッセージの入力欄。
 *
 * ChatGPT風の一体型のピル。本文の下に操作の行を置き、添付・コンテキスト
 * クリア・モデルの選択・送信をひとつの枠に収める。生成中は送信が停止に
 * 入れ替わる（押す場所が変わらないので、止めたいときに探さなくて済む）。
 *
 * モデルの選択は以前ヘッダーに居た。iPhone の幅ではヘッダーに
 * タイトルとモデル名の両方が入らず、親指からも遠い。Claude の iOS
 * アプリと同じく入力欄の中に置くと、切り替えが手元で済み、ヘッダーは
 * タイトルだけになる。Mac でも同じ配置で成立するので、端末で分けない。
 */
import type { ClipboardEvent, ReactNode, RefObject } from "react";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE as MAX_ATTACHMENTS,
} from "../../lib/constants";
import { formatBytes } from "../../lib/image";
import { PROSE_INPUT } from "../../lib/ui";
import {
  IconArrowUp,
  IconBroom,
  IconPlus,
  IconWarningTriangle,
  IconX,
} from "../icons";
import type { PendingAttachment } from "./use-attachments";

/** 入力欄の中の丸いアイコンボタン。指で押せる大きさ（36px）を確保する。 */
const TOOL_BUTTON =
  "grid h-9 w-9 shrink-0 place-items-center rounded-full transition hover:bg-black/[0.05] active:scale-90 disabled:opacity-30 dark:hover:bg-white/10";

export function Composer({
  pending,
  onRemovePending,
  supportsImages,
  fileInputRef,
  onPickFiles,
  onOpenFilePicker,
  input,
  onChangeInput,
  onSend,
  onPaste,
  textareaRef,
  narrow,
  isStreaming,
  onStop,
  canSend,
  uploading,
  canClearContext,
  contextCleared,
  hasContextBoundary,
  onClearContext,
  modelPicker,
}: {
  /** アップロード中／済みの添付。送れるのは status === "ready" のもの。 */
  pending: PendingAttachment[];
  onRemovePending: (localId: string) => void;
  /** 選んでいるモデルが画像入力に対応しているか。 */
  supportsImages: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPickFiles: (files: File[]) => void;
  onOpenFilePicker: () => void;
  input: string;
  onChangeInput: (value: string) => void;
  onSend: () => void;
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** 画面が狭い。プレースホルダを短くする。 */
  narrow: boolean;
  isStreaming: boolean;
  onStop: () => void;
  canSend: boolean;
  uploading: boolean;
  /** いまコンテキストを切れる状態か。 */
  canClearContext: boolean;
  /** 末尾で既に切ってある。 */
  contextCleared: boolean;
  /** 会話のどこかに境界線がある（ほうきに色を付ける）。 */
  hasContextBoundary: boolean;
  onClearContext: () => void;
  /** モデルの選択（チップ）。Chat 本体が組み立てて渡す。 */
  modelPicker: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-[1.625rem] border border-neutral-200/80 bg-white/85 shadow-lg shadow-black/5 backdrop-blur-xl backdrop-saturate-150 transition-colors focus-within:border-neutral-300 dark:border-white/10 dark:bg-neutral-900/80 dark:focus-within:border-white/20">
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {pending.map((p) => (
              <div
                key={p.localId}
                className={`group/att relative h-16 w-16 overflow-hidden rounded-xl border ${
                  p.status === "error"
                    ? "border-red-300 dark:border-red-800"
                    : "border-neutral-200 dark:border-neutral-700"
                }`}
                title={
                  p.status === "error"
                    ? p.error
                    : `${p.name}（${formatBytes(p.size)}）`
                }
              >
                <img
                  src={p.previewUrl}
                  alt={p.name}
                  className={`h-full w-full object-cover ${
                    p.status === "ready" ? "" : "opacity-40"
                  }`}
                />
                {p.status === "uploading" && (
                  <span className="absolute inset-0 grid place-items-center">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-accent" />
                  </span>
                )}
                {p.status === "error" && (
                  <span className="absolute inset-0 grid place-items-center text-red-500">
                    <IconWarningTriangle className="h-5 w-5" />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onRemovePending(p.localId)}
                  aria-label="添付を削除"
                  className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-white opacity-0 transition group-hover/att:opacity-100 focus:opacity-100 touch:opacity-100"
                >
                  <IconX className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {pending.length > 0 && !supportsImages && (
          <p className="px-4 pt-2 text-xs text-amber-600 dark:text-amber-400">
            このモデルは画像入力に対応していません。画像は無視されるか、エラーになる場合があります。
          </p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_IMAGE_TYPES.join(",")}
          multiple
          hidden
          onChange={(e) => {
            onPickFiles([...(e.target.files ?? [])]);
            e.target.value = ""; // 同じファイルの再選択を許す
          }}
        />
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => onChangeInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          onPaste={onPaste}
          rows={1}
          translate="no"
          {...PROSE_INPUT}
          placeholder={
            narrow ? "メッセージ" : "メッセージを入力…（Shift+Enterで改行）"
          }
          className="chat-text block max-h-[200px] min-h-[36px] w-full resize-none bg-transparent px-4 pb-1 pt-3 leading-6 outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <button
            type="button"
            onClick={onOpenFilePicker}
            disabled={pending.length >= MAX_ATTACHMENTS}
            title={
              supportsImages
                ? "画像を添付（貼り付け・ドラッグ&ドロップも可）"
                : "このモデルは画像入力に対応していません（添付は可能ですが無視されます）"
            }
            aria-label="画像を添付"
            className={`${TOOL_BUTTON} text-ink-2`}
          >
            <IconPlus className="h-5 w-5" />
          </button>
          {/*
            コンテキストクリア。履歴は消さず、ここから前を
            モデルへ渡さなくするだけ（消すときは削除選択モードで選ぶ）。
          */}
          <button
            type="button"
            onClick={onClearContext}
            disabled={!canClearContext}
            aria-label="コンテキストをクリア"
            title={
              contextCleared
                ? "ここでコンテキストをクリア済み（削除モードで選んで消せます）"
                : "コンテキストをクリア（履歴は残したまま、ここから前をモデルへ渡さない）"
            }
            className={`${TOOL_BUTTON} ${
              hasContextBoundary
                ? "text-accent-ink"
                : "text-ink-2"
            }`}
          >
            <IconBroom className="h-5 w-5" />
          </button>
          <div className="ml-0.5 min-w-0 flex-1">{modelPicker}</div>
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition hover:bg-accent/85 active:scale-90"
              aria-label="停止"
            >
              <span className="block h-3 w-3 rounded-[3px] bg-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend || uploading}
              title={uploading ? "画像をアップロード中…" : "送信"}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition hover:bg-accent/85 active:scale-90 disabled:opacity-30"
              aria-label="送信"
            >
              <IconArrowUp className="h-4.5 w-4.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
