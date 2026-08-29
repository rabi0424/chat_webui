import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ポーリングのルートが、実際に差分と 304 を返すか。
 *
 * 組み立ての規則そのものは tests/polling.test.ts で見る。ここでは
 * 「ルートがその規則を正しく当てているか」——差分にしてよい条件の判定と、
 * 札の突き合わせ——を、本物のルートを呼んで確かめる。
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
  path: [] as {
    id: string;
    status: string | null;
    flushed_at: number | null;
  }[],
}));

vi.mock("../../app/lib/db.server", () => ({
  getMessage: async () => state.message,
  getConversation: async () => ({ id: "c1", current_leaf_message_id: "m1" }),
  getConversationPath: async () => state.path,
  switchToBranch: async () => true,
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
const pathRoute = await import("../../app/routes/api.conversations.$id.path");

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
  state.path = [
    { id: "m1", status: "streaming", flushed_at: 100 },
    { id: "m2", status: null, flushed_at: 90 },
  ];
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
      successes: 1,
      attempts: 2,
      inflight: 1,
      retry: { target: 4, maxAttempts: 12, concurrency: 2 } as never,
    });
    const got = await poll(5);
    expect(got.contentDelta).toBeUndefined();
    expect(got.content).toBe(state.message.content);
  });
});

describe("パス追いのルート", () => {
  const get = (etag?: string) =>
    pathRoute.loader({
      request: new Request("https://x/api/conversations/c1/path", {
        headers: etag ? { "If-None-Match": etag } : undefined,
      }),
      params: { id: "c1" },
    } as never) as Promise<Response>;

  it("札を返す", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeTruthy();
  });

  it("同じ札を送り返すと 304（本文を運ばない）", async () => {
    const first = await get();
    const etag = first.headers.get("ETag")!;
    const second = await get(etag);
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("本文が伸びたら 200 で返る", async () => {
    const etag = (await get()).headers.get("ETag")!;
    state.path[0].flushed_at = 101;
    expect((await get(etag)).status).toBe(200);
  });

  it("応答が積まれたら 200 で返る", async () => {
    const etag = (await get()).headers.get("ETag")!;
    state.path.push({ id: "m3", status: null, flushed_at: 101 });
    expect((await get(etag)).status).toBe(200);
  });

  it("枝が切り替わったら 200 で返る（件数が同じでも）", async () => {
    const etag = (await get()).headers.get("ETag")!;
    state.path[1] = { id: "other", status: null, flushed_at: 90 };
    expect((await get(etag)).status).toBe(200);
  });

  it("古い札を送っても 304 にはならない", async () => {
    expect((await get('W/"0-zzz"')).status).toBe(200);
  });
});
