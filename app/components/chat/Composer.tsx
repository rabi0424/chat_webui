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
  useCallback,
  useRef,
  useState,
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
import { useEscapeToClose, useOutsideToClose } from "../../lib/dismiss";
import type { MentionState } from "../../lib/mention";
import type { BotRow } from "../../lib/db.server";
import type { ModelInfo } from "../../lib/openrouter.server";
import { shortModelName } from "../ModelPicker";
import { MentionSuggest } from "./MentionSuggest";
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

  const mentionText = input.slice(0, mention.replaceEnd);
  /**
   * 候補を出すか。
   *
   * 宛先が決まっていない打ちかけのあいだと、決まってはいるが本文が
   * まだ無いあいだ（もっと長い名前へ打ち足せる）だけ出す。本文を
   * 打ち始めたら引っ込める。
   */
  const suggestOpen =
    mention.present &&
    mention.candidates.length > 0 &&
    dismissedFor !== mentionText &&
    (mention.bot == null || mention.replaceEnd === input.length);

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

  const closeSuggest = useCallback(
    () => setDismissedFor(mentionText),
    [mentionText],
  );
  useEscapeToClose(suggestOpen, closeSuggest);
  useOutsideToClose(suggestOpen, closeSuggest, panelRef, pillRef);

  /** textarea をスクロールしたら、色分けの板も同じだけ動かす。 */
  const syncOverlay = () => {
    if (overlayRef.current && textareaRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const addressee = mention.bot;
  const addresseeModel = addressee
    ? models.find((m) => m.id === addressee.model_id)
    : undefined;

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
          /*
            宛先が効いていることの説明。色分けだけでは「宛先として
            採用された」ことは分かっても、**どのモデルで返ってくるか**
            が分からない。チップに出ているモデルとは違うものが使われる
            ので、その場で見せておく
          */
          <p className="flex items-center gap-1.5 px-4 pt-2 text-xs">
            <span aria-hidden>{addressee.icon}</span>
            <span className="font-medium text-accent-ink">{addressee.name}</span>
            <span className="min-w-0 truncate text-ink-3">
              宛て・{shortModelName(addresseeModel, addressee.model_id)}
            </span>
            <button
              type="button"
              onClick={onClearMention}
              className="shrink-0 rounded px-1 text-ink-3 hover:bg-hover hover:text-ink-2"
            >
              解除
            </button>
          </p>
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
            {addressee ? input.slice(mention.replaceEnd) : input}
          </div>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => onChangeInput(e.target.value)}
            onScroll={syncOverlay}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (suggestOpen) {
                const n = mention.candidates.length;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  moveActive((i) => (i + 1 + n) % n);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  moveActive((i) => (i <= 0 ? n - 1 : i - 1));
                  return;
                }
                // Tab は「補完」。どれも選んでいなければ先頭を採る。
                // Enter は選んでいるときだけ横取りする（送信を邪魔しない）
                if (e.key === "Tab" || (e.key === "Enter" && activeIndex >= 0)) {
                  e.preventDefault();
                  onPickMention(mention.candidates[Math.max(activeIndex, 0)]);
                  return;
                }
              }
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
