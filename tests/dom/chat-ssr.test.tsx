/**
 * 会話の画面を**サーバーで描いたとき**、本文まで描いていないか。
 *
 * 本文は Markdown として描いていて、その道具立て（数式・強調表示・
 * 記法の解釈）はどれも重い。会話のURLへ文書として入る（再読み込み・
 * PWAの起動・共有されたURLを開く）と、この画面はサーバーで一度描かれる。
 * 24件ぶん描くと Workers の中で実測1秒近いCPUを使い、上限（無料プランで
 * 1回の呼び出しにつき10ms）を二桁超える。超えた呼び出しは Cloudflare に
 * 打ち切られ、利用者には「Error 1102 Worker exceeded resource limits」の
 * 画面が出る。
 *
 * 画面内の移動では起きない（ローダーがクライアント側で走るので、
 * サーバーは描かない）ため、ふだん使っていても気づけない。壊れても
 * 画面にエラーが出ない類なので、ここで見張る。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, Outlet } from "react-router";
import { Chat } from "../../app/components/Chat";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";
import { TEST_MODEL, msg } from "./helpers/chat-harness";
import type { UiMessage } from "../../app/lib/types";

/** 本文にだけ現れる印。器（入力欄など）には出ない語にする。 */
const BODY_MARK = "ここは本文です";

function history(count: number): UiMessage[] {
  return Array.from({ length: count }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `${BODY_MARK}${i}`, {
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
      Component: () => <Outlet context={shell} />,
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
  it.each([1, 5, 30])(
    "%i件でも、サーバーが返すのは器だけで本文は入らない",
    (count) => {
      const html = serverHtml(history(count));
      // 器は描けている。これが無ければ「落ちたから本文も無い」だけになる
      expect(html).toContain("メッセージを入力");
      expect(html).not.toContain(BODY_MARK);
    },
  );
});
