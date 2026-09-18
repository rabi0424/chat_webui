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
 *
 * 冒頭の `@ボット名`（宛先メンション）も、下の入力欄と同じように効く。
 * 書き直しの動機は「宛先を間違えた」「同じことを別のボットにも聞きたい」
 * であることが多く、ここで効かないと、枝を作るために下の入力欄へ文面を
 * 写し直すしかない。候補の出し方・キー操作は use-mention-suggest に
 * 1つだけ置いてあるものを使う。
 */
import {
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { UiAttachment } from "../../lib/types";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE as MAX_ATTACHMENTS,
} from "../../lib/constants";
import { isAcceptedImage } from "../../lib/image";
import { PROSE_INPUT } from "../../lib/ui";
import { isImeKeystroke } from "../../lib/ime";
import { applyMention, parseMention, stripMention } from "../../lib/mention";
import type { BotRow } from "../../lib/db.server";
import { IconPlus } from "../icons";
import { useMessageActions } from "./message-context";
import { MentionSuggest } from "./MentionSuggest";
import { MentionAddressee } from "./MentionAddressee";
import { useMentionSuggest } from "./use-mention-suggest";

/**
 * 編集中のメッセージ。
 *
 * 指すのは**位置ではなくID**。添字で覚えていたころは、編集を開いたまま
 * 別のメッセージのページャで枝を切り替えると、同じ添字が別の発言を指す
 * ようになり、編集欄がその発言へ付き替わっていた（打ちかけの文はそのまま
 * 残るので、書いていた相手が入れ替わったことに気づけない）。保存すると
 * 移った先の枝の発言を親として枝が作られる（監査 C-2）。
 */
export interface EditingState {
  /** 編集対象のメッセージID。位置はそのつど messages から引き直す。 */
  id: string;
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

  const { bots, models } = useMessageActions();
  const boxRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mention = useMemo(
    () => parseMention(editing.text, bots),
    [editing.text, bots],
  );
  const setText = (text: string) =>
    setEditing((prev) => (prev ? { ...prev, text } : prev));
  /** 候補を選んだ。本文を書き換え、続きを打てる位置へキャレットを置く。 */
  const pickMention = (b: BotRow) => {
    const next = applyMention(editing.text, mention, b);
    setText(next.text);
    const el = textareaRef.current;
    if (!el) return;
    // 値が反映されてからでないと選択位置を動かせない
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };
  const {
    open: suggestOpen,
    activeIndex,
    handleKeyDown: onMentionKeyDown,
  } = useMentionSuggest({
    text: editing.text,
    mention,
    onPick: pickMention,
    panelRef,
    anchorRef: boxRef,
  });

  return (
    <div
      ref={boxRef}
      className="rounded-2xl border border-accent/50 bg-neutral-50 p-3 dark:bg-neutral-900"
    >
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
      {mention.bot && (
        /*
          ここには色分けの帯を敷かない。帯は textarea の裏に同じ字送りの
          板を敷いて背景だけを塗る作りで、利用者が縦に伸ばせる（resize-y）
          この欄では、伸ばした瞬間に帯だけがずれる。宛先が効いていること
          は、この行（ボット・実際に使われるモデル・解除）で示す
        */
        <MentionAddressee
          bot={mention.bot}
          models={models}
          onClear={() => setText(stripMention(editing.text, mention))}
          className="mb-1"
        />
      )}
      <textarea
        ref={textareaRef}
        value={editing.text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKeystroke(e.nativeEvent)) return;
          // 候補が拾ったキーは改行まで届かせない
          onMentionKeyDown(e);
        }}
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
      {suggestOpen && (
        <MentionSuggest
          anchorRef={boxRef}
          panelRef={panelRef}
          bots={mention.candidates}
          models={models}
          activeIndex={activeIndex}
          onPick={pickMention}
        />
      )}
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
          className="grid h-8 w-8 place-items-center rounded-full text-ink-2 hover:bg-hover disabled:opacity-30"
        >
          <IconPlus className="h-4.5 w-4.5" />
        </button>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="rounded-lg px-3 py-1.5 text-ink-2 hover:bg-hover"
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
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-neutral-600 hover:bg-hover disabled:opacity-30 dark:border-neutral-600 dark:text-neutral-300"
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
