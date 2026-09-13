import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ブラウザが記録した標本と、サーバーが読み取る列の結び付き。
 *
 * 送る側（app/lib/perf.ts）と受ける側（app/routes/api.perf.ts）は、
 * 項目の名前だけで繋がっている。片方で名前を変えても型は合ったままで、
 * **画面にはエラーが出ず、端末やブラウザの内訳だけが「不明」で埋まる**。
 * 記録が貯まったあとで気づいても、その期間の内訳はもう戻らない。
 *
 * ここでは本物の perf.ts に記録させ、その JSON をそのままルートへ渡す。
 */
const recorded = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("../../app/lib/db.server", () => ({
  recordPerfSamples: async (rows: Record<string, unknown>[]) => {
    recorded.rows = rows;
    return rows.length;
  },
  perfHistory: async () => ({ builds: [], groups: [] }),
  clearPerfSamples: async () => {
    recorded.rows = [];
  },
}));

/** localStorage の代わり（perf.ts は控えをここへ置く）。 */
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
});

const perf = await import("../../app/lib/perf");
const route = await import("../../app/routes/api.perf");

const post = (body: unknown) =>
  route.action({
    request: new Request("https://example.test/api/perf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {} as never,
  } as never);

beforeEach(() => {
  store.clear();
  recorded.rows = [];
});

describe("実測の受け取り", () => {
  it("ブラウザが記録した項目は、そのまま列になる", async () => {
    perf.recordNavigation("/chat/abc-123", 42.6);
    const samples = perf.loadSamples();
    const res = await post({ samples });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });

    const info = perf.clientInfo();
    const [row] = recorded.rows;
    expect(row).toMatchObject({
      id: samples[0].id,
      at: samples[0].t,
      build: perf.currentBuildId(),
      path: "/chat/:id",
      ms: 43,
      deviceId: info.deviceId,
      device: info.device,
      browser: info.browser,
      mode: info.mode,
    });
  });

  /**
   * 形の違う1件で全体を断らない。控えは成功するまで消えないので、
   * 壊れた1件を理由に 400 を返すと、その端末は以後ずっと何も送れない。
   */
  it("形の違う標本は、その1件だけを捨てる", async () => {
    perf.recordNavigation("/images", 10);
    const good = perf.loadSamples();
    const res = await post({
      samples: [{ id: "", t: 1, ms: 1, path: "/x", build: "b" }, ...good, { nope: true }],
    });
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(recorded.rows).toHaveLength(1);
    expect(recorded.rows[0].path).toBe("/images");
  });

  it("項目が欠けていても、記録は残る（欠けた所だけ不明になる）", async () => {
    await post({
      samples: [{ id: "x", t: 5, ms: 7, path: "/images", build: "b1" }],
    });
    expect(recorded.rows[0]).toMatchObject({
      deviceId: "unknown",
      device: "不明",
      browser: "不明",
      mode: "browser",
    });
  });

  it("配列でなければ断る", async () => {
    const res = await post({ samples: "いろいろ" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});

describe("履歴の問い合わせ", () => {
  const get = (query: string) =>
    route.loader({
      request: new Request(`https://example.test/api/perf${query}`),
      params: {},
      context: {} as never,
    } as never);

  /** 画面から来た文字列をそのまま SQL へ渡さないこと。 */
  it("知らない切り口は、既定へ落とす", async () => {
    const res = await get("?dimension=;DROP TABLE perf_samples");
    expect((await res.json()).dimension).toBe("path");
  });

  it("選べる切り口はそのまま通る", async () => {
    const res = await get("?dimension=device");
    expect((await res.json()).dimension).toBe("device");
  });
});
