/**
 * 本文を描く前に置いておく、**素のテキストのままの**やり取り。
 *
 * サーバーが返すのは器だけで、本文はブラウザに出てから Markdown として
 * 描く（Error 1102 対策。§3.3）。その結果、読み込みが終わった時点で文書に
 * 入っている文字は画面まわりの日本語だけになっていた——`<html lang="en">`
 * と宣言しても、Safari は自分で本文を数えて言語を決めるので、英語の会話でも
 * 「日本語のページ」と判定して翻訳を出さない。実測で、英語の会話を開いた
 * ときの HTML に入っていた文字はこれだけだった:
 *
 *   「Chat ボット管理 画像 使用量 フォルダ お気に入り 0 会話 …… ↻ 再生成」
 *
 * そこで、宣言の元にしたのと**同じ本文**（`languageSample()`）を、素の
 * テキストとしてサーバーからも出す。Markdown の道具立て（記法の解釈・
 * 数式・強調表示）はどれも重いが、テキストをそのまま流すだけなら
 * ほとんど掛からない——CPU上限に引っかかるのは描画のほうで、文字数では
 * ないため。
 *
 * ハイドレーション時もここが描かれる（`renderStage` は "none" から始まる）
 * ので、サーバーの出力とクライアントの初回描画は一致する。その直後に段が
 * 進んで本物の描画へ差し替わる。
 *
 * 見た目を本物へ寄せてあるのは、差し替わる瞬間の飛びを小さくするため。
 * ついでに、JS が届くまでのあいだ画面が空にならなくなる。
 */
import type { UiMessage } from "../../lib/types";
import { languageSample } from "../../lib/content-language";

export function PlainMessages({ messages }: { messages: UiMessage[] }) {
  return (
    <div className="space-y-6">
      {languageSample(messages).map(({ message, text }, i) => {
        return message.role === "user" ? (
          <div key={i} className="flex justify-end">
            <div className="max-w-[85%] min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap rounded-3xl rounded-br-lg bg-accent px-4 py-2.5 text-accent-fg">
              {text}
            </div>
          </div>
        ) : (
          <div
            key={i}
            className="min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap"
          >
            {text}
          </div>
        );
      })}
    </div>
  );
}
