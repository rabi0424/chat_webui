import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 1件追いのルートが、実際に差分を返すか。
 *
 * 組み立ての規則そのものは tests/polling.test.ts で見る。ここでは
 * 「ルートがその規則を正しく当てているか」——差分にしてよい条件の判定——を、
 * 本物のルートを呼んで確かめる。パス追いの札と 304 は、本物の SQLite で
 * 動かす tests/server/path-route.test.ts で見る。
 * 規則が正しくても当て方を間違えれば、本文が壊れて画面に出る。
 */

const state = vi.hoisted(() => ({
  message: {
    content: "",
    reasoning: null as string | null,
    status: "streaming" as string,
    error: null as string | null,
    usage_json: null as string | null,
    citations_json: null as string | null,
  },
}));

vi.mock("../../app/lib/db.server", () => ({
  getMessage: async () => state.message,
}));
vi.mock("../../app/lib/serialize.server", () => ({
  toUiMessage: (m: { id: string }) => ({
    id: m.id,
    role: "assistant",
    content: "",
  }),
  parseUsage: () => null,
  parseCitations: () => null,
}));

const messageRoute =
  await import("../../app/routes/api.conversations.$id.messages.$mid");

const BODY = "これは生成中の本文です。".repeat(20);

async function poll(since: number | null) {
  const url =
    since == null
      ? "https://x/api/conversations/c1/messages/m1"
      : `https://x/api/conversations/c1/messages/m1?since=${since}`;
  const res = await messageRoute.loader({
    request: new Request(url),
    params: { id: "c1", mid: "m1" },
  } as never);
  return (await (res as Response).json()) as {
    content?: string;
    contentDelta?: string;
    contentLength: number;
  };
}

beforeEach(() => {
  state.message = {
    content: BODY,
    reasoning: null,
    status: "streaming",
    error: null,
    usage_json: null,
    citations_json: null,
  };
});

describe("1件追いのルート", () => {
  it("生成中の本文は、since から先だけを返す", async () => {
    const got = await poll(10);
    expect(got.contentDelta).toBe(BODY.slice(10));
    expect(got.content).toBeUndefined();
    expect(got.contentLength).toBe(BODY.length);
  });

  it("since を付けなければ全文（最初の1回）", async () => {
    const got = await poll(null);
    expect(got.content).toBe(BODY);
    expect(got.contentDelta).toBeUndefined();
  });

  it("確定済みの応答は全文で返す（要約に置き換わっていることがある）", async () => {
    state.message.status = "done";
    state.message.content = "**完了** — 成功 3件";
    const got = await poll(50);
    expect(got.content).toBe("**完了** — 成功 3件");
    expect(got.contentDelta).toBeUndefined();
  });

  it("「成功するまで生成」の見出しは全文で返す（毎秒書き直されるため）", async () => {
    const { formatRetryProgress } = await import("../../app/lib/retry");
    state.message.content = formatRetryProgress({
      target: 4,
      successes: 1,
      attempts: 2,
      maxAttempts: 12,
      refusals: 1,
      emptyResponses: 0,
      transients: 0,
      running: 1,
      slots: 2,
      waitSeconds: 0,
      stopping: false,
    });
    const got = await poll(5);
    expect(got.contentDelta).toBeUndefined();
    expect(got.content).toBe(state.message.content);
  });
});
