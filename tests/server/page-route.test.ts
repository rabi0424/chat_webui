import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../../app/lib/settings";

/**
 * 取り込みの入口（`POST /api/page`）と、設定の結び付き。
 *
 * 上限は設定（`pageMaxMb` / `pageTimeoutSec`）に置いてあるが、**ルートが
 * 引き忘れても型では気づけない**（既定の上限が使われるだけで、画面には
 * 何も出ない）。設定を変えて、実際の振る舞いが変わることで見る。
 */
let stored: AppSettings = { ...DEFAULT_APP_SETTINGS };

vi.mock("../../app/lib/db.server", () => ({
  getAppSettings: async () => stored,
}));

const { action } = await import("../../app/routes/api.page");

/** 上流の振りをする。本文の大きさだけを決められる。 */
function installFetch(options: { bytes?: number } = {}) {
  globalThis.fetch = (async () =>
    new Response("a".repeat(options.bytes ?? 10), {
      headers: { "Content-Type": "text/html" },
    })) as typeof fetch;
}

const call = (url: string) =>
  action({
    request: new Request("https://chat.example.com/api/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),
    params: {},
    context: {} as never,
  } as never) as Promise<Response>;

describe("取り込みの入口", () => {
  it("設定した大きさを超えるページは断る", async () => {
    stored = { ...DEFAULT_APP_SETTINGS, pageMaxMb: 1 };
    installFetch({ bytes: 1024 * 1024 + 1 });
    const res = await call("https://example.com/a");
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: expect.stringContaining("1MB") });
  });

  it("上げれば通る（同じページ・同じ本文）", async () => {
    stored = { ...DEFAULT_APP_SETTINGS, pageMaxMb: 2 };
    installFetch({ bytes: 1024 * 1024 + 1 });
    const res = await call("https://example.com/a");
    expect(res.status).toBe(200);
  });

  it("url が無ければ 400（バインディングにも触らない）", async () => {
    const res = await action({
      request: new Request("https://chat.example.com/api/page", {
        method: "POST",
        body: "{}",
      }),
      params: {},
      context: {} as never,
    } as never as never);
    expect((res as Response).status).toBe(400);
  });
});
