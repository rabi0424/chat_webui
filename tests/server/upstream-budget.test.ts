import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 上流へ投げた本数の数え方。
 *
 * Workers は1回の呼び出しで出せる外部リクエストの数に上限があり
 * （無料プランでは50件）、使い切ると以降の fetch がその場で失敗する。
 * 「成功するまで生成」は上限の手前で切り上げて続きを次のアラームへ
 * 送る作りなので、**数えが実際より少ないと切り上げが効かない**。
 *
 * サーバーツールが弾かれたときのやり直しは2件目を投げるが、呼ぶ側は
 * 「1回 = 1件」で数えていた。
 */
const sent = vi.hoisted(() => ({ calls: [] as unknown[], status: 200 }));

vi.mock("../../app/lib/openrouter.server", async (orig) => {
  const actual =
    await orig<typeof import("../../app/lib/openrouter.server")>();
  return {
    ...actual,
    openRouterChatRequest: async (body: Record<string, unknown>) => {
      sent.calls.push(body);
      // 1件目（サーバーツール付き）だけ弾く指定
      const first = sent.calls.length === 1;
      const status = first ? sent.status : 200;
      return new Response(status === 200 ? "ok" : "bad", { status });
    },
    poeChatRequest: async (body: Record<string, unknown>) => {
      sent.calls.push(body);
      return new Response("ok", { status: 200 });
    },
  };
});

const { requestUpstream } = await import("../../app/lib/generation.server");

const job = (extra: Record<string, unknown> = {}) =>
  ({
    conversationId: "c1",
    assistantMessageId: "a1",
    model: "openai/gpt-4o",
    web: false,
    webTools: false,
    imageOutput: false,
    paramsState: null,
    messages: [],
    ...extra,
  }) as unknown as Parameters<typeof requestUpstream>[0];

beforeEach(() => {
  sent.calls = [];
  sent.status = 200;
});

/** 投げるたびに1つ増えるカウンタ。 */
function counter() {
  let n = 0;
  return { spend: () => n++, get: () => n };
}

describe("投げた本数を数える", () => {
  it("ふつうの生成は1件", async () => {
    const c = counter();
    await requestUpstream(job(), [], c.spend);
    expect(c.get()).toBe(1);
    expect(sent.calls).toHaveLength(1);
  });

  it("Poe も1件", async () => {
    const c = counter();
    await requestUpstream(job({ model: "poe:Claude" }), [], c.spend);
    expect(c.get()).toBe(1);
  });

  it("サーバーツールを使っても、通れば1件", async () => {
    const c = counter();
    await requestUpstream(job({ web: true, webTools: true }), [], c.spend);
    expect(c.get()).toBe(1);
    expect(sent.calls).toHaveLength(1);
  });

  /** これが直したかったところ。 */
  it("サーバーツールが弾かれてやり直したら2件", async () => {
    sent.status = 400;
    const c = counter();
    await requestUpstream(job({ web: true, webTools: true }), [], c.spend);
    expect(sent.calls).toHaveLength(2);
    expect(c.get()).toBe(2);
  });

  it("400 以外では、やり直さない", async () => {
    sent.status = 500;
    const c = counter();
    const res = await requestUpstream(
      job({ web: true, webTools: true }),
      [],
      c.spend,
    );
    expect(res.status).toBe(500);
    expect(c.get()).toBe(1);
  });

  it("数える関数を渡さなくても動く", async () => {
    await expect(requestUpstream(job(), [])).resolves.toBeInstanceOf(Response);
  });
});

describe("やり直しの中身", () => {
  it("2件目はツールを外し、検索プラグインの側へ下がる", async () => {
    sent.status = 400;
    await requestUpstream(job({ web: true, webTools: true }), [], () => {});
    const [withTools, without] = sent.calls as Record<string, unknown>[];
    expect(withTools.tools).toBeDefined();
    expect(without.tools).toBeUndefined();
    // ツールを渡さないときは、モデル名の接尾辞で検索を頼む
    expect(String(without.model)).toContain(":online");
  });
});
