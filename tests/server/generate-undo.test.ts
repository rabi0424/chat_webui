import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 生成の開始に失敗したときの後始末。
 *
 * beginGeneration は行を保存してから返る。そのあとで生成の実行を登録
 * できなかった場合、保存だけが残る——ユーザーの発言と、永久に
 * 「生成中」のままの応答が木に積まれる。利用者から見ると失敗したので
 * 送り直すが、そのたびに**同じ発言が増えていく**。
 */
const state = vi.hoisted(() => ({
  startOk: true,
  limitBlocked: false,
  undoCalls: [] as unknown[],
}));

vi.mock("../../app/lib/db.server", () => ({
  getConversation: async () => ({
    id: "c1",
    current_leaf_message_id: "old-leaf",
  }),
  getAppSettings: async () => ({ retryAttemptCeiling: 100 }),
  beginGeneration: async () => ({
    userMessageId: "u1",
    assistantMessageId: "a1",
  }),
  undoGeneration: async (p: unknown) => {
    state.undoCalls.push(p);
  },
}));
vi.mock("../../app/lib/limit.server", () => ({
  checkMonthlyLimit: async () => ({ blocked: state.limitBlocked }),
  limitMessage: () => "上限です",
}));

const route = await import("../../app/routes/api.conversations.$id.generate");

/** Durable Object の起動を差し替えた context。 */
const context = {
  get: () => ({
    env: {
      GENERATOR: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () =>
            new Response(state.startOk ? "ok" : "ng", {
              status: state.startOk ? 200 : 500,
            }),
        }),
      },
    },
  }),
};

const send = () =>
  route.action({
    request: new Request("https://x/api/conversations/c1/generate", {
      method: "POST",
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "こんにちは" }],
        userContent: "こんにちは",
      }),
    }),
    params: { id: "c1" },
    context,
  } as never);

beforeEach(() => {
  state.startOk = true;
  state.limitBlocked = false;
  state.undoCalls = [];
});

describe("生成の開始", () => {
  it("うまくいけば、取り消さない", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(state.undoCalls).toHaveLength(0);
  });

  /** これが直したかったところ。 */
  it("実行を登録できなければ、保存した分を取り消す", async () => {
    state.startOk = false;
    const res = await send();
    expect(res.status).toBe(502);
    expect(state.undoCalls).toHaveLength(1);
  });

  it("取り消しは、始める前の位置へ戻すよう頼む", async () => {
    state.startOk = false;
    await send();
    expect(state.undoCalls[0]).toMatchObject({
      conversationId: "c1",
      userMessageId: "u1",
      assistantMessageId: "a1",
      previousLeafId: "old-leaf",
    });
  });

  it("上限で止めるときは、そもそも保存しない", async () => {
    state.limitBlocked = true;
    const res = await send();
    expect(res.status).toBe(402);
    // 保存していないので、取り消すものも無い
    expect(state.undoCalls).toHaveLength(0);
  });
});
