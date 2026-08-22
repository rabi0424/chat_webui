import { describe, expect, it } from "vitest";
import { fetchJson } from "../app/lib/fetch-json";
import { loadNotices } from "../app/lib/shell-status";

/**
 * 画面の裏で取りに行くもの（モデル一覧・為替）の失敗の扱い（監査 C-2）。
 *
 * もとは .catch(() => {}) で握りつぶしていた。モデル一覧が取れないと
 * 選べるモデルが0件になり、送信もできないが、画面には何も出ないので
 * 利用者からは理由の分からない故障にしか見えなかった。
 */

/** 決められた順に応答を返す fetch。何回呼ばれたかも数える。 */
function stubFetch(steps: (Response | Error)[]): typeof fetch & { calls: number } {
  let n = 0;
  const impl = (async () => {
    const step = steps[Math.min(n, steps.length - 1)];
    n++;
    impl.calls = n;
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch & { calls: number };
  impl.calls = 0;
  return impl;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const noWait = () => Promise.resolve();

describe("裏の取得", () => {
  it("一度で取れれば、そのまま返す", async () => {
    const impl = stubFetch([json({ usdJpy: 150 })]);
    const got = await fetchJson<{ usdJpy: number }>("/api/fx", {
      fetchImpl: impl,
      sleep: noWait,
    });
    expect(got).toEqual({ ok: true, value: { usdJpy: 150 } });
    expect(impl.calls).toBe(1);
  });

  /**
   * コールドスタートや上流の一時的な失敗は、待てば直る。ここで
   * 諦めると、利用者に「再試行」を押させることになる。
   */
  it("つながらないときは投げ直し、通れば成功として返す", async () => {
    const impl = stubFetch([new TypeError("Failed to fetch"), json({ usdJpy: 150 })]);
    const got = await fetchJson<{ usdJpy: number }>("/api/fx", {
      fetchImpl: impl,
      sleep: noWait,
    });
    expect(got.ok).toBe(true);
    expect(impl.calls).toBe(2);
  });

  it("5xx と 429 は投げ直す", async () => {
    for (const status of [500, 502, 429]) {
      const impl = stubFetch([json({}, status), json({ usdJpy: 150 })]);
      const got = await fetchJson("/api/fx", { fetchImpl: impl, sleep: noWait });
      expect(got.ok, String(status)).toBe(true);
      expect(impl.calls, String(status)).toBe(2);
    }
  });

  /**
   * 404 や 400 は投げ直しても同じ答えが返る。待つぶんだけ、画面に
   * 理由が出るのが遅れる。
   */
  it("4xx は投げ直さずに諦める", async () => {
    for (const status of [400, 404, 403]) {
      const impl = stubFetch([json({ error: "だめ" }, status)]);
      const got = await fetchJson("/api/fx", { fetchImpl: impl, sleep: noWait });
      expect(got, String(status)).toEqual({
        ok: false,
        reason: `サーバーが ${status} を返しました`,
      });
      expect(impl.calls, String(status)).toBe(1);
    }
  });

  it("ずっと駄目なら、最後の理由を返す", async () => {
    const impl = stubFetch([new TypeError("Failed to fetch")]);
    const got = await fetchJson("/api/fx", {
      fetchImpl: impl,
      sleep: noWait,
      attempts: 3,
    });
    expect(got).toEqual({ ok: false, reason: "つながりませんでした" });
    expect(impl.calls).toBe(3);
  });

  it("本文が壊れているときは投げ直さない", async () => {
    const impl = stubFetch([
      new Response("こわれている", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ]);
    const got = await fetchJson("/api/models", { fetchImpl: impl, sleep: noWait });
    expect(got).toEqual({ ok: false, reason: "応答を読み取れませんでした" });
    expect(impl.calls).toBe(1);
  });

  it("投げ直す前に待つ（間を置かずに叩き続けない）", async () => {
    const waited: number[] = [];
    const impl = stubFetch([new TypeError("x")]);
    await fetchJson("/api/fx", {
      fetchImpl: impl,
      attempts: 3,
      sleep: (ms) => {
        waited.push(ms);
        return Promise.resolve();
      },
    });
    expect(waited).toHaveLength(2);
    expect(waited[0]).toBeGreaterThan(0);
    // 2回目はより長く待つ（同じ間隔で叩き続けない）
    expect(waited[1]).toBeGreaterThan(waited[0]);
  });
});

describe("失敗の伝え方", () => {
  const none = { models: null, hasCachedModels: false, fx: null };

  it("成功しているあいだは何も出さない", () => {
    expect(loadNotices(none)).toEqual([]);
  });

  /**
   * 同じ「取れなかった」でも影響が違う。手元に一覧が無ければ
   * 何も送れないが、あれば古いものを使って続けられる。
   */
  it("手元に一覧が無いときは、送れないことまで伝える", () => {
    const [notice] = loadNotices({ ...none, models: "つながりませんでした" });
    expect(notice).toContain("つながりませんでした");
    expect(notice).toContain("送信もできません");
  });

  it("手元に一覧があるときは、古いものを見ていると伝える", () => {
    const [notice] = loadNotices({
      ...none,
      models: "つながりませんでした",
      hasCachedModels: true,
    });
    expect(notice).toContain("前回の一覧");
    expect(notice).not.toContain("送信もできません");
  });

  it("為替は、ドル表示に戻ることを伝える", () => {
    const [notice] = loadNotices({ ...none, fx: "サーバーが 500 を返しました" });
    expect(notice).toContain("ドル");
    expect(notice).toContain("500");
  });

  it("両方失敗したら、両方出す", () => {
    const notices = loadNotices({ models: "A", hasCachedModels: false, fx: "B" });
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("モデル");
    expect(notices[1]).toContain("為替");
  });
});
