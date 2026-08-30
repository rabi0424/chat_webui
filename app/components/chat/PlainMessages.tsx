/**
 * 本文を描く前に置いておく、**記法を解釈しないままの**やり取り。
 *
 * サーバーが返すのは器だけで、本文はブラウザに出てから Markdown として
 * 描く（Error 1102 対策。§3.3）。その結果、読み込みが終わった時点で文書に
 * 本文が1文字も無くなり、Safari が言語を数えられずに翻訳ボタンを出さなく
 * なっていた。そこで、宣言の元にしたのと同じ本文（`languageSample()`）を
 * サーバーからも出す。Markdown の道具立て（記法の解釈・数式・強調表示）は
 * どれも重いが、文字を段落に入れて流すだけならほとんど掛からない——CPU
 * 上限に効くのは描画であって文字数ではないため。
 *
 * **本文は `<p>` に入れる。`white-space: pre-wrap` は掛けない。**
 * ここが今回の肝。最初は素のテキストを `<div>` に直接置き、改行を保つため
 * `whitespace-pre-wrap` を掛けていた——本文は文書に入ったのに、翻訳ボタンは
 * 出ないままだった。壊れる前（本文をサーバーで描いていたころ）の HTML と
 * 比べて分かったのは、**文字の中身でも量でも位置でもなく、入れ物が違う**
 * ということだった:
 *
 *   壊れる前（出た）: <div class="prose"><p>Could you explain…</p></div>
 *   直したつもり（出ない）: <div class="whitespace-pre-wrap">Could you explain…</div>
 *
 * 文字の並びは同じで、日本語の割合もほぼ同じ（19.5% と 17.9%）。むしろ
 * 出ていたほうが文書の先頭100字の81%が日本語だった。違いは、本文が段落に
 * 入っていないことと、整形済みテキスト（＝コードのような扱いを受けうる）
 * だったことだけ。したがってここは、壊れる前と**同じ形**を作る。
 *
 * ハイドレーション直後まで同じものを描き（`renderStage` は "none" から
 * 始まる）、そのあと本物の描画へ入れ替える。枠のクラスも本物と共有して
 * あるので、入れ替わる瞬間の飛びも小さい。
 */
import type { UiMessage } from "../../lib/types";
import { languageSample } from "../../lib/content-language";
import { proseClassName } from "../Markdown";

/**
 * 段落に割る。
 *
 * 空行で切り、段落の中の改行は空白でつなぐ。Markdown が描くときと同じ
 * 区切り方で、`<p>` がそのまま対応する（`white-space` に頼らないので、
 * 整形済みテキストとして扱われることもない）。
 */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

export function PlainMessages({ messages }: { messages: UiMessage[] }) {
  return (
    <div className="space-y-6">
      {languageSample(messages).map(({ message, text }, i) => {
        const body = paragraphs(text).map((p, j) => <p key={j}>{p}</p>);
        // 枠は本物（UserMessage / AssistantMessage）と同じものを使う
        return message.role === "user" ? (
          <div key={i} className="flex justify-end">
            <div className="max-w-[85%] min-w-0 [overflow-wrap:anywhere] rounded-3xl rounded-br-lg bg-accent px-4 py-2.5 text-accent-fg">
              <div className={proseClassName("chat-bubble")}>{body}</div>
            </div>
          </div>
        ) : (
          <div key={i} className={proseClassName()}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
