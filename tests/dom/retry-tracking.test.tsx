import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { installServer, msg, renderChat } from "./helpers/chat-harness";
import { formatRetryProgress, type RetryProgress } from "../../app/lib/retry";
import { encodeRunProgress, RUN_PROGRESS_HEADER } from "../../app/lib/polling";
import type { UiMessage } from "../../app/lib/types";

/**
 * 「成功するまで生成」のパス追い。
 *
 * 追跡は毎秒 /path を叩く。以前は札（ETag）が司令役の毎秒の書き込みで
 * 動いてしまい、ほぼ毎回、積み上がった成功の本文を全部運び直し、並びを
 * 丸ごと差し替えていた（変わっていない応答まで描き直す）。
 *
 * いまの取り決め:
 *   - 札は見出しの進捗を見ない。何も積まれていなければ 304 が返り、
 *     見出しの進捗はそのヘッダーで届く
 *   - 200 で受け取っても、変わっていない行は前の物を使い回す
 *   - 終わったあとの取り直し（画面へ戻ったとき）も札を送る
 */

const renders = vi.hoisted(() => ({
  count: 0,
  /** 行IDごとに、描画へ渡された行の物（同一性を見る）。 */
  seen: new Map<string, Set<unknown>>(),
}));
vi.mock("../../app/components/chat/AssistantMessage", async (orig) => {
  const actual =
    await orig<typeof import("../../app/components/chat/AssistantMessage")>();
  return {
    ...actual,
    AssistantMessage: (props: Parameters<typeof actual.AssistantMessage>[0]) => {
      renders.count++;
      const id = props.m.id ?? "";
      const set = renders.seen.get(id) ?? new Set();
      set.add(props.m);
      renders.seen.set(id, set);
      return actual.AssistantMessage(props);
    },
  };
});

const progress = (p: Partial<RetryProgress> = {}) =>
  formatRetryProgress({
    target: 3,
    successes: 1,
    attempts: 4,
    maxAttempts: 100,
    refusals: 3,
    emptyResponses: 0,
    transients: 0,
    running: 2,
    slots: 3,
    waitSeconds: 0,
    stopping: false,
    ...p,
  });

/** サーバー側の状態。/path はここから答える。 */
const remote = {
  messages: [] as UiMessage[],
  etag: 'W/"1"',
  /** 304 に添える見出しの進捗。 */
  progress: "",
};
/** /path への GET が送ってきた札（送らなければ null）。 */
let tags: (string | null)[] = [];

const initial = (): UiMessage[] => [
  msg("user", "猫の絵", { id: "u1" }),
  msg("assistant", progress(), { id: "h1", status: "streaming" }),
  msg("assistant", "一枚目の成功", { id: "s1" }),
];

beforeEach(() => {
  localStorage.clear();
  renders.count = 0;
  renders.seen.clear();
  tags = [];
  remote.messages = initial();
  remote.etag = 'W/"1"';
  remote.progress = progress();
  installServer();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    if (!path.endsWith("/path") || (init?.method ?? "GET") !== "GET") {
      return inner(input, init);
    }
    const tag = new Headers(init?.headers).get("If-None-Match");
    tags.push(tag);
    if (tag && tag === remote.etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: remote.etag,
          [RUN_PROGRESS_HEADER]: encodeRunProgress({
            id: "h1",
            content: remote.progress,
          }),
        },
      });
    }
    // JSON を通すので、行は毎回新しい物になる（本物の応答と同じ）
    return new Response(JSON.stringify({ messages: remote.messages }), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: remote.etag },
    });
  }) as typeof fetch;
});

/** 「投げた」の欄に出ている数。 */
const attemptsShown = () =>
  screen.getByText("投げた").nextElementSibling?.textContent;

async function tracking(): Promise<void> {
  renderChat({ conversationId: "c1", initialMessages: initial() });
  // 追跡が始まり、札を受け取って送り返すところまで進む
  await waitFor(() => expect(tags).toContain(remote.etag), { timeout: 4000 });
}

describe("成功するまで生成のパス追い", () => {
  it("何も積まれていなければ 304。見出しの進捗はそのヘッダーで進む", async () => {
    await tracking();
    expect(attemptsShown()).toBe("4 / 100");

    // 司令役が数字だけ打ち直した。札は変わらない
    remote.progress = progress({ attempts: 9, running: 1 });
    await waitFor(() => expect(attemptsShown()).toBe("9 / 100"), {
      timeout: 4000,
    });
    // 本文を運び直していない（最初の1回だけが札なし）
    expect(tags.filter((t) => t == null)).toHaveLength(1);
    expect(tags.filter((t) => t === remote.etag).length).toBeGreaterThan(0);
  });

  it("進捗が同じ 304 では、何も描き直さない", async () => {
    await tracking();
    await new Promise((r) => setTimeout(r, 50));
    renders.count = 0;
    const before = tags.length;
    await waitFor(() => expect(tags.length).toBeGreaterThanOrEqual(before + 2), {
      timeout: 4000,
    });
    expect(renders.count).toBe(0);
    // 描き直さなかったのは一覧が消えたからではない
    expect(screen.getByText("一枚目の成功")).toBeInTheDocument();
    expect(attemptsShown()).toBe("4 / 100");
  });

  it("成功が積まれたら 200 で受け取り、変わっていない応答は前の物のまま", async () => {
    await tracking();
    const firstS1 = [...(renders.seen.get("s1") ?? [])];
    expect(firstS1).toHaveLength(1);

    remote.messages = [
      ...initial().slice(0, 1),
      msg("assistant", progress({ successes: 2, attempts: 6 }), {
        id: "h1",
        status: "streaming",
      }),
      ...initial().slice(2),
      msg("assistant", "二枚目の成功", { id: "s2" }),
    ];
    remote.etag = 'W/"2"';
    expect(await screen.findByText("二枚目の成功", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(attemptsShown()).toBe("6 / 100");
    // s1 は JSON から作り直されて届いたが、描画には前の物が渡り続けている
    expect([...(renders.seen.get("s1") ?? [])]).toEqual(firstS1);
    // 見出しは変わったので新しい物
    expect(renders.seen.get("h1")?.size).toBeGreaterThan(1);
  });

  it("終わったあとの取り直しは札を送り、変わっていなければ運び直さない", async () => {
    await tracking();
    remote.messages = [
      ...initial().slice(0, 1),
      msg("assistant", "**完了** — 成功 1件", { id: "h1" }),
      ...initial().slice(2),
    ];
    remote.etag = 'W/"done"';
    expect(await screen.findByText("完了", { exact: false }, { timeout: 4000 })).toBeInTheDocument();
    const before = tags.length;

    // アプリへ戻った
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(tags.length).toBe(before + 1));
    expect(tags[tags.length - 1]).toBe('W/"done"');
    expect(screen.getByText("一枚目の成功")).toBeInTheDocument();
  });

  it("読み込んだばかりの並びには札が無いので、取り直しは札を送らない", async () => {
    renderChat({
      conversationId: "c1",
      initialMessages: [
        msg("user", "質問", { id: "u1" }),
        msg("assistant", "答え", { id: "a1" }),
      ],
    });
    expect(await screen.findByText("答え")).toBeInTheDocument();
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(tags).toHaveLength(1));
    expect(tags[0]).toBeNull();
  });
});
