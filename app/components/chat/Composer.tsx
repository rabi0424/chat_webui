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
import {
  useRef,
  type ClipboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE as MAX_ATTACHMENTS,
} from "../../lib/constants";
import { formatBytes } from "../../lib/image";
import { PROSE_INPUT } from "../../lib/ui";
import type { MentionState } from "../../lib/mention";
import type { BotRow } from "../../lib/db.server";
import type { ModelInfo } from "../../lib/openrouter.server";
import { MentionSuggest } from "./MentionSuggest";
import { MentionAddressee } from "./MentionAddressee";
import { useMentionSuggest } from "./use-mention-suggest";
import {
  IconArrowUp,
  IconBroom,
  IconPlus,
  IconWarningTriangle,
  IconX,
} from "../icons";
import { MAX_PAGE_TEXT_CHARS } from "../../lib/page-limits";
import { hostLabel } from "../../lib/page-url";
import type { PendingAttachment } from "./use-attachments";
import {
  countLines,
  snapSelectionOutsideTokens,
  splitByPasteTokens,
  type CollapsedPaste,
} from "../../lib/paste";

/** 入力欄の中の丸いアイコンボタン。指で押せる大きさ（36px）を確保する。 */
const TOOL_BUTTON =
  "grid h-9 w-9 shrink-0 place-items-center rounded-full transition hover:bg-black/[0.05] active:scale-90 disabled:opacity-30 dark:hover:bg-white/10";

/**
 * 本文の字送りと余白。
 *
 * textarea と、その裏に敷く色分け用の板（オーバーレイ）で**必ず同じ
 * ものを使う**。片方だけ変えると色の帯だけが文字からずれる——画面に
 * エラーは出ず、ずれていることに気づく手立ても無いので、値をここに
 * 1つだけ置き、`tests/dom/chat-mention.test.tsx` で結び付きを見張る。
 */
export const COMPOSER_TEXT =
  "chat-text px-4 pb-1 pt-3 leading-6 whitespace-pre-wrap break-words";

export function Composer({
  pending,
  onRemovePending,
  supportsImages,
  fileInputRef,
  onPickFiles,
  onOpenFilePicker,
  input,
  onChangeInput,
  pastes,
  onExpandPaste,
  onRemovePaste,
  onRetryPage,
  onSend,
  onPaste,
  textareaRef,
  narrow,
  isStreaming,
  onStop,
  canSend,
  uploading,
  loadingPages,
  canClearContext,
  contextCleared,
  hasContextBoundary,
  onClearContext,
  modelPicker,
  mention,
  models,
  onPickMention,
  onClearMention,
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
  /** 畳んだ貼り付け（本文の札が指す中身）。 */
  pastes: CollapsedPaste[];
  /** 札を本文に戻す。 */
  onExpandPaste: (paste: CollapsedPaste) => void;
  /** 札ごと捨てる（ページはリンクの文字だけ残す）。 */
  onRemovePaste: (paste: CollapsedPaste) => void;
  /** 取り込めなかったページを取りに行き直す。 */
  onRetryPage: (paste: CollapsedPaste) => void;
  onSend: () => void;
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** 画面が狭い。プレースホルダを短くする。 */
  narrow: boolean;
  isStreaming: boolean;
  onStop: () => void;
  canSend: boolean;
  uploading: boolean;
  /** 取り込みの終わっていないページがある（読み終えるまで送らせない）。 */
  loadingPages: boolean;
  /** いまコンテキストを切れる状態か。 */
  canClearContext: boolean;
  /** 末尾で既に切ってある。 */
  contextCleared: boolean;
  /** 会話のどこかに境界線がある（ほうきに色を付ける）。 */
  hasContextBoundary: boolean;
  onClearContext: () => void;
  /** モデルの選択（チップ）。Chat 本体が組み立てて渡す。 */
  modelPicker: ReactNode;
  /** 冒頭のメンションの解析結果（Chat が本文から作る）。 */
  mention: MentionState<BotRow>;
  /** 候補に添えるモデル名を引くため。 */
  models: ModelInfo[];
  onPickMention: (bot: BotRow) => void;
  /** 宛先の指定を本文から取り除く。 */
  onClearMention: () => void;
}) {
  const pillRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /*
    候補の開閉・↑↓・キー操作は編集欄（MessageEditor）と同じものを使う。
    同じ操作感を2箇所に書き写すと、次に直すとき片方だけが直る
  */
  const {
    open: suggestOpen,
    mentionText,
    activeIndex,
    handleKeyDown: onMentionKeyDown,
  } = useMentionSuggest({
    text: input,
    mention,
    onPick: onPickMention,
    panelRef,
    anchorRef: pillRef,
  });

  /** textarea をスクロールしたら、色分けの板も同じだけ動かす。 */
  const syncOverlay = () => {
    if (overlayRef.current && textareaRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const addressee = mention.bot;

  return (
    <div className="mx-auto max-w-3xl">
      <div
        ref={pillRef}
        className="rounded-[1.625rem] border border-neutral-200/80 bg-white/85 shadow-lg shadow-black/5 backdrop-blur-xl backdrop-saturate-150 transition-colors focus-within:border-neutral-300 dark:border-white/10 dark:bg-neutral-900/80 dark:focus-within:border-white/20"
      >
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
        {pastes.length > 0 && (
          /*
            畳んだ貼り付けの一覧。本文の札は文字なので中身が見えない。
            ここで行数と字数を示し、「展開」で本文に戻して編集できる
            ようにする（添付にする各社のアプリで「編集できない」が
            いちばんの不満だった）。
          */
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {pastes.map((p) => {
              const kind = p.url ? "ページ" : "貼り付け";
              return (
                <div
                  key={p.n}
                  title={p.url ? (p.finalUrl ?? p.url) : undefined}
                  className="flex max-w-full items-center gap-1 rounded-lg border border-line bg-neutral-50 py-1 pl-2.5 pr-1 text-xs text-ink-2 dark:bg-white/5"
                >
                  <span className="shrink-0 font-medium text-ink">
                    {kind} #{p.n}
                  </span>
                  {p.url && (
                    <span className="max-w-[9rem] truncate">
                      {hostLabel(p.finalUrl ?? p.url)}
                    </span>
                  )}
                  {/*
                    取り込みの途中・失敗は、ここでしか分からない。札は
                    本文に入ったままなので、何も出さないと「読めたつもり」
                    で送ることになる
                  */}
                  {p.status === "loading" ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-accent" />
                      読み込み中…
                    </span>
                  ) : p.status === "error" ? (
                    <span className="flex min-w-0 items-center gap-1 text-red-600 dark:text-red-400">
                      <IconWarningTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        {p.error ?? "読み込めませんでした"}
                      </span>
                    </span>
                  ) : (
                    <span className="shrink-0 tabular-nums">
                      {countLines(p.text)}行・{p.text.length.toLocaleString()}字
                    </span>
                  )}
                  {/*
                    上限で切ったことは、**送る前に**見えていないと意味が
                    ない。本文の末尾にも同じ断りが入るが、そちらは札を
                    展開しないと読めない
                  */}
                  {p.truncated && (
                    <span
                      className="shrink-0 text-amber-600 dark:text-amber-400"
                      title={`長いので先頭だけを取り込みました（${MAX_PAGE_TEXT_CHARS.toLocaleString()}字まで）`}
                    >
                      一部
                    </span>
                  )}
                  {p.status === "error" && (
                    <button
                      type="button"
                      onClick={() => onRetryPage(p)}
                      aria-label={`${kind} #${p.n} を再取得`}
                      title="もう一度取りに行く"
                      className="ml-1 shrink-0 rounded px-1.5 py-0.5 hover:bg-hover hover:text-ink"
                    >
                      再取得
                    </button>
                  )}
                  {p.status !== "loading" && p.status !== "error" && (
                    <button
                      type="button"
                      onClick={() => onExpandPaste(p)}
                      aria-label={`${kind} #${p.n} を本文に展開`}
                      title="本文に展開して編集する"
                      className="ml-1 shrink-0 rounded px-1.5 py-0.5 hover:bg-hover hover:text-ink"
                    >
                      展開
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemovePaste(p)}
                    aria-label={
                      p.url ? `ページ #${p.n} の取り込みをやめる` : `貼り付け #${p.n} を削除`
                    }
                    title={
                      p.url ? "取り込みをやめて、リンクのまま送る" : undefined
                    }
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-full hover:bg-hover hover:text-ink"
                  >
                    <IconX className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
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
        {addressee && (
          <MentionAddressee
            bot={addressee}
            models={models}
            onClear={onClearMention}
            className="px-4 pt-2"
          />
        )}
        <div className="relative">
          {/*
            確定した宛先だけを色分けする板。textarea は背景を持たない
            ので、この帯が文字の裏に透ける。**文字はここでは描かない**
            （text-transparent）——文字まで描くと、字送りが少しでも
            ずれた瞬間に二重に見える。塗るのは背景だけにしておけば、
            最悪でも帯の位置がずれるだけで本文は読める。
          */}
          <div
            ref={overlayRef}
            aria-hidden
            translate="no"
            className={`pointer-events-none absolute inset-0 overflow-hidden text-transparent ${COMPOSER_TEXT}`}
          >
            <span
              data-testid="mention-mark"
              className="rounded bg-accent/20 [box-decoration-break:clone]"
            >
              {addressee ? mentionText : ""}
            </span>
            {/* 貼り付けの札にも薄く色を付け、文字ではなく「札」だと分かるようにする */}
            {splitByPasteTokens(
              addressee ? input.slice(mention.replaceEnd) : input,
            ).map((seg, i) =>
              seg.token ? (
                <span
                  key={i}
                  className="rounded bg-neutral-500/15 [box-decoration-break:clone]"
                >
                  {seg.text}
                </span>
              ) : (
                seg.text
              ),
            )}
          </div>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => onChangeInput(e.target.value)}
            /*
              キャレットは札の中に入れない（近いほうの端へ寄せる）。
              札の途中に文字を打てると、その瞬間に札が壊れて貼り付け
              との結び付きが切れる。端に居れば、消す操作は札ごと消える
              （Chat の editInput）。
            */
            onSelect={(e) => {
              const el = e.currentTarget;
              const snapped = snapSelectionOutsideTokens(el.value, {
                start: el.selectionStart,
                end: el.selectionEnd,
              });
              if (snapped) el.setSelectionRange(snapped.start, snapped.end);
            }}
            onScroll={syncOverlay}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              // 候補が拾ったキーは送信まで届かせない
              if (onMentionKeyDown(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
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
            className={`relative block max-h-[200px] min-h-[36px] w-full resize-none bg-transparent outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500 ${COMPOSER_TEXT}`}
          />
        </div>
        {suggestOpen && (
          <MentionSuggest
            anchorRef={pillRef}
            panelRef={panelRef}
            bots={mention.candidates}
            models={models}
            activeIndex={activeIndex}
            onPick={onPickMention}
          />
        )}
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
              disabled={!canSend || uploading || loadingPages}
              title={
                uploading
                  ? "画像をアップロード中…"
                  : loadingPages
                    ? "ページを読み込み中…"
                    : "送信"
              }
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
