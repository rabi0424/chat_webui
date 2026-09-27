import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientLoader } from "../../app/routes/chat.$id";
import { prefetchChat, resetChatCache } from "../../app/lib/chat-cache";

/**
 * 押した会話の先読みが途中なら、会話画面はそれを待つ。
 *
 * 先読みは同時数を絞って順に投げるので、押した時点で「取りに行って
 * いる最中」のことが増えた。そこで写しが無いからとサーバーへもう1本
 * 投げると、同じ会話を丸ごと引く要求が2本並ぶ。
 */
let resolveFull: ((ok: boolean) => void) | null;
let serverLoads: number;
beforeEach(() => {
  resetChatCache();
  serverLoads = 0;
  resolveFull = null;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      resolveFull = (ok) =>
        resolve(
          new Response(
            JSON.stringify({
              conversation: { id: "c1", title: "先読み", updated_at: 1 },
              messages: [],
            }),
            { status: ok ? 200 : 500 },
          ),
        );
    })) as typeof fetch;
});
afterEach(() => resetChatCache());

const load = () =>
  clientLoader({
    params: { id: "c1" },
    serverLoader: async () => {
      serverLoads++;
      return {
        conversation: { id: "c1", title: "サーバー", updated_at: 1 },
        messages: [],
      };
    },
  } as never) as Promise<{ conversation: { title: string } }>;

describe("会話画面の読み込みと先読み", () => {
  it("先読みが途中なら、サーバーへ2本目を投げずにそれを待つ", async () => {
    prefetchChat("c1");
    const loading = load();
    resolveFull!(true);
    expect((await loading).conversation.title).toBe("先読み");
    expect(serverLoads).toBe(0);
  });

  it("先読みが失敗したら、自分でサーバーから取る", async () => {
    prefetchChat("c1");
    const loading = load();
    resolveFull!(false);
    expect((await loading).conversation.title).toBe("サーバー");
    expect(serverLoads).toBe(1);
  });
});
