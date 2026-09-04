/**
 * 会話の画面を**サーバーで描いたとき**、何を出して何を出さないか。
 *
 * 出してはいけないのは **Markdown の描画**。その道具立て（記法の解釈・
 * 数式・強調表示）はどれも重い。会話のURLへ文書として入る（再読み込み・
 * PWAの起動・共有されたURLを開く）と、この画面はサーバーで一度描かれる。
 * 24件ぶん描くと Workers の中で実測1秒近いCPUを使い、上限（無料プランで
 * 1回の呼び出しにつき10ms）を二桁超える。超えた呼び出しは Cloudflare に
 * 打ち切られ、利用者には「Error 1102 Worker exceeded resource limits」の
 * 画面が出る。
 *
 * 逆に出さなければいけないのが**素のテキストとしての本文**。器だけを
 * 返していたころ、読み込みが終わった時点の文書に入っている文字は画面
 * まわりの日本語だけだった（実測: 英語の会話を開いても「Chat ボット管理
 * 画像 使用量 …… ↻ 再生成」の73文字しか無い）。`<html lang="en">` と
 * 宣言しても、Safari は自分で本文を数えて言語を決めるので、英語の会話でも
 * 「日本語のページ」と判定して翻訳ボタンを出さない。
 *
 * どちらの壊れ方も**画面内の移動では起きない**（ローダーがクライアント側で
 * 走るのでサーバーは描かない）うえ、画面にエラーも出ない。ここで見張る。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, Outlet } from "react-router";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";
import { Chat } from "../../app/components/Chat";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { LANGUAGE_SAMPLE_LIMIT } from "../../app/lib/content-language";
import { TEST_MODEL, msg } from "./helpers/chat-harness";
import type { UiMessage } from "../../app/lib/types";

/** 本文にだけ現れる印。器（入力欄など）には出ない語にする。 */
const BODY_MARK = "ここは本文です";

/**
 * Markdown として描かれたら形が変わるもの。素のテキストのままなら
 * 記号がそのまま残る。
 */
const MARKUP = "**強調** と $x^2$ と\n\n| 列 | 値 |\n|---|---|\n| a | 1 |";

function history(count: number): UiMessage[] {
  return Array.from({ length: count }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `${BODY_MARK}${i}\n${MARKUP}`, {
      id: `m-${i}`,
    }),
  );
}

function serverHtml(messages: UiMessage[]): string {
  const shell = {
    models: [TEST_MODEL],
    bots: [],
    usdJpy: 150,
    settings: DEFAULT_APP_SETTINGS,
    openSidebar: () => {},
  };
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ConfirmProvider>
          <Outlet context={shell} />
        </ConfirmProvider>
      ),
      children: [
        {
          index: true,
          Component: () => (
            <Chat conversationId="conv-1" initialMessages={messages} />
          ),
        },
      ],
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/"]} />);
}

describe("会話の画面のサーバー描画", () => {
  it.each([1, 5, 30])("%i件でも Markdown は描かない", (count) => {
    const html = serverHtml(history(count));
    // 器は描けている。これが無ければ「落ちたから何も無い」だけになる
    expect(html).toContain("メッセージを入力");
    // 記法が解釈されていない＝重い道具立てが動いていない
    expect(html).not.toMatch(/<strong[ >]/);
    expect(html).not.toContain("katex");
    expect(html).not.toMatch(/<table[ >]/);
    expect(html).not.toContain("hljs");
    // 解釈されていないなら、記号は書いたまま残っているはず。
    // 「<strong> が無い」だけでは、本文ごと消えていても通ってしまう
    expect(html).toContain("**強調**");
  });

  it("本文は記法を解釈しないまま入る（Safari に言語を数えさせるため）", () => {
    const html = serverHtml(history(3));
    expect(html).toContain(`${BODY_MARK}2`);
  });

  /**
   * ここが今回いちばん静かに壊れるところ。
   *
   * 本文を `<div>` に直接置き、改行を保つため `whitespace-pre-wrap` を
   * 掛けていたとき、**文字は文書に入っているのに翻訳ボタンは出なかった**。
   * 壊れる前（本文をサーバーで描いていたころ）の HTML と比べると、文字の
   * 中身も量も並びも同じで、違いは入れ物だけだった:
   *
   *   出た  : <div class="prose"><p>本文</p></div>
   *   出ない: <div class="whitespace-pre-wrap">本文</div>
   *
   * 戻しても画面の見た目はほとんど変わらないので、ここで見張る。
   */
  it("本文は段落に入っていて、整形済みテキストにはなっていない", () => {
    const html = serverHtml(history(1));
    const body = html.indexOf(`${BODY_MARK}0`);
    expect(body).toBeGreaterThanOrEqual(0);
    // 本文の直前が <p>（段落に入っている）
    expect(html.slice(0, body)).toMatch(/<p[^>]*>$/);
    // 本文を囲む枠は、本物の描画と同じ prose
    expect(html.slice(0, body)).toMatch(/class="prose[^"]*"><p[^>]*>$/);
    /*
      整形済みテキストとして扱われる掛け方をしていない。
      見張るのは**本文の入れ物**なので、フッター（入力欄）より前だけを
      見る——入力欄には、宛先メンションの色分け用に textarea と同じ
      字送りで敷く板があり、そちらは pre-wrap で正しい（textarea の
      描き方をなぞる板なので、ここを外すと色の帯が文字からずれる）。
    */
    const feed = html.slice(0, html.indexOf("<footer"));
    expect(feed).toContain(`${BODY_MARK}0`);
    expect(feed).not.toContain("whitespace-pre-wrap");
  });

  it("長い会話でも、載せる本文は判定に要るぶんで頭打ちになる", () => {
    // 1件2KB × 60件 = 120KB。全部載せると HTML がそのぶん膨らむ
    const long = Array.from({ length: 60 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", "あ".repeat(2000), {
        id: `m-${i}`,
      }),
    );
    const body = serverHtml(long).match(/あ+/g) ?? [];
    const total = body.reduce((n, s) => n + s.length, 0);
    expect(total).toBeGreaterThanOrEqual(LANGUAGE_SAMPLE_LIMIT);
    // 上限に届いた1件は丸ごと入れるので、行き過ぎるのは高々1件ぶん
    expect(total).toBeLessThanOrEqual(LANGUAGE_SAMPLE_LIMIT * 2);
  });
});
