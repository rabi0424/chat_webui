import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIMENSION_LABELS,
  clientInfo,
  currentBuildId,
  delta,
  describeClient,
  flushSamples,
  formatHistory,
  historyRows,
  rowLabel,
  loadSamples,
  normalizePath,
  recordNavigation,
  type PerfBuild,
  type PerfGroup,
} from "../app/lib/perf";
import { PERF_DIMENSIONS } from "../app/lib/schema";

beforeEach(() => {
  localStorage.clear();
});

/**
 * 端末とブラウザの名乗りの読み方。
 *
 * 判定の順番が全て。Edge の名乗りには "Chrome" も "Safari" も入って
 * いるので、素直に "Chrome" から見ると Edge が Chrome として記録され、
 * **端末別・ブラウザ別の比較が静かに間違う**（画面にはそれらしい名前が
 * 出続ける）。iPad の Safari は「Macintosh」と名乗るので、触れる点の
 * 数でしか Mac と区別できない。
 */
describe("端末とブラウザの見分け", () => {
  const cases: [string, { ua: string; touch?: number }, string, string][] = [
    [
      "iPhone の Safari",
      {
        ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      },
      "iPhone",
      "Safari 18",
    ],
    [
      "iPad の Safari（Macintosh と名乗る）",
      {
        ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
        touch: 5,
      },
      "iPad",
      "Safari 18",
    ],
    [
      "Mac の Safari",
      {
        ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
        touch: 0,
      },
      "Mac",
      "Safari 18",
    ],
    [
      "Mac の Chrome",
      {
        ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      "Mac",
      "Chrome 131",
    ],
    [
      "Windows の Edge",
      {
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      },
      "Windows",
      "Edge 131",
    ],
    [
      "Android の Chrome",
      {
        ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      },
      "Android",
      "Chrome 131",
    ],
    [
      "iPhone の Firefox",
      {
        ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15",
      },
      "iPhone",
      "Firefox 133",
    ],
  ];

  for (const [name, input, device, browser] of cases) {
    it(name, () => {
      const got = describeClient({
        userAgent: input.ua,
        standalone: false,
        maxTouchPoints: input.touch,
      });
      expect([got.device, got.browser]).toEqual([device, browser]);
    });
  }

  it("ホーム画面から開いた全画面表示は、タブと区別される", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Version/18.1 Safari/604.1";
    expect(describeClient({ userAgent: ua, standalone: true }).mode).toBe("standalone");
    expect(describeClient({ userAgent: ua, standalone: false }).mode).toBe("browser");
  });
});

describe("記録", () => {
  it("個別IDを含むパスは、ルートの形へ丸める", () => {
    expect(normalizePath("/chat/abc-123")).toBe("/chat/:id");
    expect(normalizePath("/bots/xyz/edit")).toBe("/bots/:id/edit");
    expect(normalizePath("/images")).toBe("/images");
  });

  /**
   * 1件ずつに、どこで測ったかを添える。ここが欠けると、サーバーには
   * 「不明」として入り、端末別・ブラウザ別の内訳が丸ごと使えなくなる。
   */
  it("標本には、ビルド・端末・ブラウザ・表示形態が付く", () => {
    recordNavigation("/chat/abc", 123.4);
    const [s] = loadSamples();
    const info = clientInfo();
    expect(s.path).toBe("/chat/:id");
    expect(s.ms).toBe(123);
    expect(s.build).toBe(currentBuildId());
    expect(s.deviceId).toBe(info.deviceId);
    expect(s.device).toBe(info.device);
    expect(s.browser).toBe(info.browser);
    expect(s.mode).toBe(info.mode);
    expect(s.id).toBeTruthy();
  });

  /**
   * 端末のIDは localStorage に残す。残さなければ、開き直すたびに別の
   * 端末として数えられ、端末別の推移が繋がらない。
   */
  it("端末のIDは残り、次に開いても同じものを使う", async () => {
    // clientInfo は文書のあいだ1度しか読まないので、まっさらから始める
    vi.resetModules();
    const fresh = await import("../app/lib/perf");
    const id = fresh.clientInfo().deviceId;
    expect(localStorage.getItem("chat-webui:perf-device")).toBe(id);

    vi.resetModules();
    const again = await import("../app/lib/perf");
    expect(again.clientInfo().deviceId).toBe(id);
  });
});

describe("送信", () => {
  const okFetch = () =>
    vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 200 }));

  it("送れたら控えから消える", async () => {
    recordNavigation("/images", 10);
    recordNavigation("/usage", 20);
    const fetchImpl = okFetch();
    expect(await flushSamples({ fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(2);
    expect(loadSamples()).toEqual([]);
    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as RequestInit).body as string,
    ) as { samples: { path: string }[] };
    expect(body.samples.map((s) => s.path)).toEqual(["/images", "/usage"]);
  });

  /**
   * 失敗しても控えは残す。成功を待たずに消していたら、通信が切れた回の
   * ぶんだけ**静かに欠ける**（欠けたことに気づく手立てが無い）。
   */
  it("送れなければ控えは残る", async () => {
    recordNavigation("/images", 10);
    const failing = vi.fn(async () => new Response("no", { status: 500 }));
    expect(await flushSamples({ fetchImpl: failing as unknown as typeof fetch })).toBe(0);
    expect(loadSamples()).toHaveLength(1);

    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await flushSamples({ fetchImpl: offline as unknown as typeof fetch })).toBe(0);
    expect(loadSamples()).toHaveLength(1);
  });

  /**
   * 送っているあいだにも遷移は起きる。送った件数だけを頭から削ると、
   * その間に記録された分が巻き添えで消える。消すのは id で選んだものだけ。
   */
  it("送信中に記録された分は消えない", async () => {
    recordNavigation("/images", 10);
    const fetchImpl = vi.fn(async () => {
      // 応答を待っているあいだに、もう1回遷移した
      recordNavigation("/usage", 20);
      return new Response("{}", { status: 200 });
    });
    expect(await flushSamples({ fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(1);
    expect(loadSamples().map((s) => s.path)).toEqual(["/usage"]);
  });

  /**
   * 送信が重なることは普通に起きる（溜まりすぎて送る・画面が隠れて送る・
   * 設定画面を開いて送る）。「送った件数だけ先頭から削る」やり方だと、
   * 2本目の削除がその間に記録された分まで持っていく——**送っていない
   * 標本が、成功したように見えたまま消える**。消すのは id で選んだものだけ。
   */
  it("送信が重なっても、まだ送っていない分は消えない", async () => {
    recordNavigation("/images", 10);
    recordNavigation("/usage", 20);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response("{}", { status: 200 });
    });
    const first = flushSamples({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const second = flushSamples({ fetchImpl: fetchImpl as unknown as typeof fetch });
    // 2本が返事を待っているあいだに、もう1回遷移した
    recordNavigation("/bots", 30);
    release!();
    await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(loadSamples().map((s) => s.path)).toEqual(["/bots"]);
  });

  it("控えが空なら、送りに行かない", async () => {
    const fetchImpl = okFetch();
    expect(await flushSamples({ fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("履歴の読み方", () => {
  const build = (name: string, at: number): PerfBuild => ({
    build: name,
    firstAt: at,
    lastAt: at,
  });
  const group = (b: string, key: string, median: number): PerfGroup => ({
    build: b,
    key,
    label: key,
    count: 10,
    median,
    p90: median * 2,
    slowest: median * 3,
    firstAt: 0,
    lastAt: 0,
  });

  /**
   * 比べる相手は「同じ内訳を持つ、次に古いビルド」。1つ前のビルドとだけ
   * 比べていたときは、そのビルドでたまたまその端末を触っていないと差が
   * 出せず、iPhone の起動だけを追う、という読み方ができなかった。
   */
  it("一つ前に記録の無いビルドは飛ばして比べる", () => {
    const builds = [build("c", 300), build("b", 200), build("a", 100)];
    const groups = [
      group("c", "iPhone", 120),
      group("b", "Mac", 50), // b には iPhone の記録が無い
      group("a", "iPhone", 200),
    ];
    const history = historyRows(builds, groups);
    const row = history[0].rows.find((r) => r.key === "iPhone")!;
    expect([row.prevBuild, row.prevMedian]).toEqual(["a", 200]);
    expect(delta(row.median, row.prevMedian ?? undefined)).toEqual({ ms: -80, pct: -40 });
  });

  it("比べる相手が無ければ、差は出さない", () => {
    const history = historyRows([build("a", 100)], [group("a", "Mac", 40)]);
    const row = history[0].rows[0];
    expect([row.prevBuild, row.prevMedian, row.prevP90]).toEqual([null, null, null]);
    expect(delta(row.median, row.prevMedian ?? undefined)).toBeNull();
  });

  it("記録の無いビルドも、行としては残る（いつ動いていたかは残す）", () => {
    const history = historyRows([build("a", 100), build("b", 200)], [group("b", "Mac", 40)]);
    expect(history.map((h) => [h.build.build, h.rows.length])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("コピーの文面に、ビルドと内訳と数字が入る", () => {
    const history = historyRows(
      [build("new", 300), build("old", 100)],
      [group("new", "iPhone", 120), group("old", "iPhone", 200)],
    );
    const text = formatHistory(history, "device");
    expect(text).toContain("端末別");
    expect(text).toContain("new");
    expect(text).toContain("iPhone");
    expect(text).toContain("中央値 120ms");
    expect(text).toContain("前回比 -80ms");
  });

  /**
   * 端末は乱数で分けているので、同じ機種を2台使うと同じ名前の行が並ぶ。
   * 名前だけだと**どちらがどちらか分からない**まま、別物として数えられて
   * いることにも気づけない。短いIDを添えて見分けられるようにする。
   */
  it("端末の行には、見分けるための短いIDが付く", () => {
    const row = group("b", "9f3c1a77", 100);
    row.label = "iPhone";
    expect(rowLabel("device", row)).toBe("iPhone #9f3c");
    expect(rowLabel("path", { ...row, key: "/images", label: "/images" })).toBe(
      "/images",
    );
    expect(rowLabel("none", { ...row, key: "", label: "" })).toBe("全体");
  });

  /** 選べる切り口が増えたのに名前が無いと、ボタンが空で出る。 */
  it("切り口には、すべて表示名がある", () => {
    for (const d of PERF_DIMENSIONS) {
      expect(DIMENSION_LABELS[d], d).toBeTruthy();
    }
  });
});
