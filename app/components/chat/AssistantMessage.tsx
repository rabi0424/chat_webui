/**
 * モデルからの応答。
 *
 * 状態によって本文の出し方が変わる：
 *  - 「成功するまで生成」の最中は、本文の代わりに試行の経過を出す
 *  - 画像生成の最中は本文が流れてこないので、秒だけ進める
 *  - 失敗したときは赤い帯と再試行
 *  - 末尾のものは、届いた文字を少しずつ滑らかに出す（StreamingMessage）
 *  - それ以外は、確定した本文をそのまま描く
 *
 * 本文の下の操作列は**アイコンだけ**で揃える。文字が要るものは吹き出し
 * （data-tip）で出す。以前は「⑂ ここから分岐」「↻ 再生成」のような
 * 文字と記号が混ざり、iPhone の幅では2行に折れていた。数字は額と秒だけを
 * 右端に置き、トークン数は ⓘ の詳細へ。
 */
import type { UiMessage } from "../../lib/types";
import { isRetryProgress } from "../../lib/retry";
import { StreamingMessage } from "../StreamingMessage";
import { IconArrowPath, IconBranch, IconTrash } from "../icons";
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
import {
  MSG_DELETE_ACTION,
  MSG_ICON_ACTION,
  MSG_TEXT_ACTION,
} from "../../lib/ui";

/** 操作列の右端に置く短い数字（額と秒）。 */
function briefMeta(m: UiMessage, usdJpy: number | null): string | null {
  const parts: string[] = [];
  const u = m.usage;
  if (u?.cost != null) {
    parts.push(usdJpy != null ? formatJpy(u.cost * usdJpy) : `$${u.cost.toFixed(4)}`);
  } else if (u?.points != null) {
    parts.push(`${u.points.toLocaleString()} pt`);
  }
  if (m.finishedAt && m.createdAt && m.finishedAt > m.createdAt) {
    parts.push(`${((m.finishedAt - m.createdAt) / 1000).toFixed(1)}秒`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

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
    openImage,
    attachGeneratedImages,
    followBottom,
  } = useMessageActions();
  const selectable = selecting != null && m.id != null;
  const isLast = index === lastIndex;
  const generatingImage = m.status === "streaming" && isImageGeneration(m.modelId);
  const meta = briefMeta(m, usdJpy);

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
          /*
           * モデルが返した画像は本文のマークダウンとして届く（添付欄には
           * 出ない）。「成功するまで生成」で積まれた画像もこちらなので、
           * ここを渡さないとタップしても何も起きない。
           *
           * ただし選択モード中は渡さない。行を選ぶつもりのタップで拡大
           * 表示まで開き、閉じたときには行も選ばれている（監査 C-8）。
           * 渡さなければ、本文の画像はただの画像に戻る。
           */
          onImageClick={selecting ? undefined : openImage}
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
        <div className="mt-1 flex items-center gap-0.5">
          {/*
            再生成は末尾の応答にだけ。以前は一覧の末尾に「↻ 再生成」の行を
            別に置いていたが、操作列に入れれば専用の行が要らない。
          */}
          {isLast && m.id && !isStreaming && m.status !== "error" && (
            <button
              type="button"
              onClick={() => regenerate()}
              aria-label="再生成"
              data-tip="再生成"
              className={`tip ${MSG_ICON_ACTION}`}
            >
              <IconArrowPath className="h-4 w-4" />
            </button>
          )}
          <CopyButton text={m.content} />
          {/*
            分岐（別の会話へ写す）は生成中でも通す。ここまでの履歴を
            読んで写すだけで、走っている生成には触れない。ただし
            書きかけの応答そのものからは写せない（まだ中身が無い）。
          */}
          {m.id && m.status !== "error" && m.status !== "streaming" && (
            <button
              type="button"
              onClick={() => fork(m.id!)}
              aria-label="ここから分岐"
              data-tip="ここから分岐（新しい会話を作成）"
              className={`tip ${MSG_ICON_ACTION}`}
            >
              <IconBranch className="h-4 w-4" />
            </button>
          )}
          <MessageDetails message={m} usdJpy={usdJpy} />
          {m.id && !isStreaming && (
            <button
              type="button"
              onClick={() => startSelect(m.id!)}
              aria-label="削除"
              data-tip="削除（選択モードへ）"
              className={`tip ${MSG_DELETE_ACTION}`}
            >
              <IconTrash className="h-4 w-4" />
            </button>
          )}
          <BranchPager message={m} onSwitch={switchBranch} />
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
          {meta && (
            <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-ink-3">
              {meta}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
