/**
 * サーバーが返す HTML の中で、**本文がサイドバーより先に来る**か。
 *
 * サイドバーを先に置くと、サーバーが描く会話一覧（20件）の日本語の
 * タイトルが文書の頭を埋める（実測で先頭100字の81%が日本語）。文書の頭は
 * その文書の主題と一致していてほしいので、本文を先にする。
 *
 * **これは Safari の翻訳が出なかった原因ではない**（原因は本文の入れ物で、
 * `tests/dom/chat-ssr.test.tsx` が見張っている）。壊れる前の HTML と
 * 比べたところ、当時はサイドバーが200件を先頭に描いていて頭はもっと
 * 日本語だったのに、翻訳は出ていた。ここは行儀の話として残してある。
 *
 * 並びを戻しても**画面には何も出ない**。`order-1` / `order-2` が見た目を
 * 元のまま（左がサイドバー）に保つので、黙って戻る。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import Shell from "../../app/routes/shell";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { conv } from "./helpers/sidebar-harness";

/** サイドバーに並ぶ日本語のタイトル（サーバーが描く上限ぶん）。 */
const JA_TITLE = "確定申告の準備メモ";
/** 本文にだけ出る英語。 */
const EN_BODY = "This is the English body of the conversation.";

function serverHtml(): string {
  const loaderData = {
    conversations: Array.from({ length: 20 }, (_, i) =>
      conv(`c-${i}`, `${JA_TITLE}${i}`),
    ),
    bots: [],
    folders: [],
    settings: DEFAULT_APP_SETTINGS,
  };
  const Stub = createRoutesStub([
    {
      path: "/",
      // Shell は loaderData を props で受ける。子が本文役
      Component: () => <Shell loaderData={loaderData} {...({} as never)} />,
      children: [{ index: true, Component: () => <p>{EN_BODY}</p> }],
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/"]} />);
}

describe("サーバーが返す HTML の並び", () => {
  it("本文が、サイドバーの日本語より先に来る", () => {
    const html = serverHtml();
    const body = html.indexOf(EN_BODY);
    const sidebar = html.indexOf(JA_TITLE);
    // どちらも描けている。片方が無いと「見つからない(-1)から先」で通る
    expect(body).toBeGreaterThanOrEqual(0);
    expect(sidebar).toBeGreaterThanOrEqual(0);
    expect(body).toBeLessThan(sidebar);
  });

  it("見た目の並び（左がサイドバー）は order で保たれている", () => {
    // 並べ替えただけで order を付け忘れると、サイドバーが右に出る。
    // 上のテストは通ったままなので、ここで別に見る
    const html = serverHtml();
    expect(html).toMatch(/class="order-2 min-w-0 flex-1"/);
    expect(html).toMatch(/class="order-1 hidden w-72/);
  });
});
