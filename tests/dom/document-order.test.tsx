/**
 * サーバーが返す HTML の中で、**本文がサイドバーより先に来る**か。
 *
 * 言語の判定は文書の先頭を標本にする。サイドバーを先に置くと、サーバーが
 * 描く会話一覧（20件）の日本語のタイトルが文書の頭を埋めてしまう——実測で
 * 先頭100字の81%、先頭200字の88%が日本語だった。英語の会話を開いても
 * Safari は「日本語のページ」と数え、翻訳ボタンが出てこない。
 *
 * **画面の幅では変わらない。** iPhone ではサイドバーは CSS で隠れている
 * だけで、HTML には同じように入っている（`innerText` で測ると隠れたぶんが
 * 落ちるので、この問題は見えなくなる。実際それで一度見落とした）。
 *
 * 並びを戻しても**画面には何も出ない**。`order-1` / `order-2` が見た目を
 * 元のまま（左がサイドバー）に保つので、翻訳が出なくなるだけになる。
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
