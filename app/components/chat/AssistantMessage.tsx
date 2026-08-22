/**
 * モデルからの応答。
 *
 * 状態によって本文の出し方が変わる：
 *  - 「成功するまで生成」の最中は、本文の代わりに試行の経過を出す
 *  - 画像生成の最中は本文が流れてこないので、秒だけ進める
 *  - 失敗したときは赤い帯と再試行
 *  - 末尾のものは、届いた文字を少しずつ滑らかに出す（StreamingMessage）
 *  - それ以外は、確定した本文をそのまま描く
 */
import type { UiMessage } from "../../lib/types";
import { isRetryProgress } from "../../lib/retry";
import { StreamingMessage } from "../StreamingMessage";
import { IconTrash } from "../icons";
import {
  BranchPager,
  CitationList,
  CopyButton,
  GenerationProgress,
  MessageDetails,
  ReasoningBlock,
  formatJpy,
} from "./message-parts";
import { selectionClassOf, useMessageActions } from "./message-context";
import { MSG_DELETE_ACTION, MSG_TEXT_ACTION } from "../../lib/ui";

export function AssistantMessage({
  m,
  index,
}: {
  m: UiMessage;
  index: number;
}) {
  const {
    isStreaming,
    selecting,
    toggleSelect,
    startSelect,
    lastIndex,
    isImageGeneration,
    usdJpy,
    switchBranch,
    fork,
    regenerate,
    attachGeneratedImages,
    followBottom,
  } = useMessageActions();
  const selectable = selecting != null && m.id != null;
  const isLast = index === lastIndex;
  const generatingImage = m.status === "streaming" && isImageGeneration(m.modelId);

  return (
    <div
      className={`group/msg ${selectionClassOf(selecting, m.id)}`}
      onClick={selectable ? () => toggleSelect(m.id) : undefined}
    >
      {m.reasoning && (
        <ReasoningBlock
          key={`r${m.id ?? index}`}
          reasoning={m.reasoning}
          streaming={isStreaming && isLast && !m.content}
        />
      )}
      {m.status === "streaming" && isRetryProgress(m.content) ? (
        // 「成功するまで生成」の見出し。経過秒はここで毎秒進める
        <GenerationProgress text={m.content} startedAt={m.createdAt} />
      ) : generatingImage ? (
        // 1枚だけの画像生成。本文が流れてこないので秒だけ進める
        <GenerationProgress text="画像を生成中…" startedAt={m.createdAt} />
      ) : m.status === "error" ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <span className="break-all">{m.error ?? "生成に失敗しました"}</span>
          {isLast && !isStreaming && (
            <button
              type="button"
              onClick={() => regenerate()}
              className="shrink-0 rounded-lg border border-red-300 px-3 py-1 hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900"
            >
              再試行
            </button>
          )}
        </div>
      ) : (
        /*
         * 末尾かどうかで描き手を変えない。以前は末尾だけ StreamingMessage、
         * それ以外は Markdown にしていたが、次の発言を送った瞬間に末尾で
         * なくなり、React が要素の型の違いを見てそこを作り直していた——
         * 出来上がっていた図が fallback に戻り、並べ替えた表が元の順に
         * 戻るのはこれ（監査 E-7）。StreamingMessage は追いつき終われば
         * Markdown と同じものを描くので、常にこちらに任せる。
         *
         * 少しずつ出す動きは streaming のときだけ働く。末尾でない発言は
         * 最初から全文が入っているので、その場で描き切る。
         */
        <StreamingMessage
          text={m.content}
          streaming={m.status === "streaming"}
          onReveal={isLast ? followBottom : undefined}
        />
      )}
      {/* 進捗の見出しは秒が動いているのでカーソルは出さない */}
      {isStreaming &&
        isLast &&
        !isRetryProgress(m.content) &&
        !generatingImage && (
          <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-neutral-400 align-text-bottom dark:bg-neutral-500" />
        )}
      {m.citations && m.citations.length > 0 && (
        <CitationList citations={m.citations} />
      )}
      {!selecting && (
        <div className="mt-1 flex items-center gap-2">
          <BranchPager
            message={m}
            disabled={isStreaming}
            onSwitch={switchBranch}
          />
          {m.usage && (
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              {m.usage.promptTokens != null &&
                `${m.usage.promptTokens} in / ${m.usage.completionTokens ?? 0} out`}
              {m.usage.points != null &&
                `${m.usage.promptTokens != null ? " · " : ""}${m.usage.points.toLocaleString()} pt`}
              {m.usage.cost != null &&
                ` · ${
                  usdJpy != null
                    ? formatJpy(m.usage.cost * usdJpy)
                    : `$${m.usage.cost.toFixed(6)}`
                }`}
            </span>
          )}
          <CopyButton text={m.content} />
          <MessageDetails message={m} usdJpy={usdJpy} />
          {m.attachments && m.attachments.length > 0 && (
            <button
              type="button"
              onClick={() => attachGeneratedImages(m.attachments!)}
              title="この画像を入力欄に添付して、編集や続きを頼む"
              className={MSG_TEXT_ACTION}
            >
              この画像を使う
            </button>
          )}
          {m.id && !isStreaming && m.status !== "error" && (
            <button
              type="button"
              onClick={() => fork(m.id!)}
              title="ここから分岐（独立した新しい会話を作成）"
              className={MSG_TEXT_ACTION}
            >
              ⑂ ここから分岐
            </button>
          )}
          {m.id && !isStreaming && (
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
        </div>
      )}
    </div>
  );
}
