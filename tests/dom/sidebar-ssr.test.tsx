/**
 * サイドバーを**サーバーで描いたとき**、一覧を全部描いていないか。
 *
 * サイドバーは全ページの土台なので、ここで描くものはどの画面を開いても
 * サーバーのCPUとHTMLに乗る。会話200件（一覧の上限）をそのまま描くと、
 * 実測で素の画面が 24.5KB/10ms のところ 245KB/27ms になっていた。
 * Workers のCPU上限は無料プランで1回の呼び出しにつき10msなので、
 * サイドバーだけで使い切る——超えた呼び出しは Cloudflare に打ち切られ、
 * 「Error 1102 Worker exceeded resource limits」で画面ごと開かなくなる。
 *
 * 一画面に入るのはせいぜい20行で、残りはブラウザに出てから足す。
 * 増えても画面には何も出ないので、ここで見張る。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { Sidebar } from "../../app/components/Sidebar";
import { conv } from "./helpers/sidebar-harness";

/** サーバーが描く上限（Sidebar の SSR_ROWS と揃える）。 */
const SSR_ROWS = 20;

function serverHtml(count: number): string {
  const conversations = Array.from({ length: count }, (_, i) =>
    conv(`c-${i}`, `会話${i}`),
  );
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <Sidebar
          conversations={conversations}
          folders={[]}
          unreadIds={null}
          generatingIds={null}
        />
      ),
    },
  ]);
  return renderToStaticMarkup(<Stub initialEntries={["/"]} />);
}

describe("サイドバーのサーバー描画", () => {
  it("一画面ぶんだけ描き、残りは描かれない", () => {
    const html = serverHtml(200);
    // 器は描けている。これが無ければ「落ちたから行も無い」だけになる
    expect(html).toContain("新規チャット");
    expect(html).toContain("会話0<");
    expect(html).toContain(`会話${SSR_ROWS - 1}<`);
    expect(html).not.toContain(`会話${SSR_ROWS}<`);
    expect(html).not.toContain("会話199<");
  });

  it("上限に満たなければ全部描く", () => {
    const html = serverHtml(5);
    for (let i = 0; i < 5; i++) expect(html).toContain(`会話${i}<`);
  });
});
