/**
 * 起動とページ遷移の所要時間の記録。
 *
 * 遷移のたびに「タップ〜画面切り替わり」の実測を localStorage へ貯め、
 * まとめて D1（perf_samples）へ送る。localStorage は**送るまでの控え**で
 * あって保管場所ではない——以前はここが唯一の保管場所で、最大1000件・
 * 60日で溢れた分は捨てていた。端末を替えれば消え、比べられるのは
 * 「現行ビルドと直前のビルド」の2つだけだったので、それより古い版の
 * 推移は辿れなかった。
 *
 * 標本は**間引かずに全部**サーバーへ渡す（平均や中央値だけを残さない）。
 * 中央値も p90 も生の並びが無ければ出せず、「端末別に見直す」「あの日
 * だけを見る」も後からはできなくなる。
 *
 * 1件ごとに、どのビルド・どの端末・どのブラウザ・どの表示形態
 * （ホーム画面からの全画面表示か、ブラウザのタブか）で測ったかを添える。
 * 起動時間はこの3つで桁が変わるので、混ぜて1つの数字にすると
 * 「速くなった」のか「速い端末で開いただけ」なのかが区別できない。
 */

import type { PerfDimension } from "./schema";

export interface PerfSample {
  /** 記録した時点でブラウザが振る乱数。送り直しても二重に入らない鍵 */
  id: string;
  /** 記録時刻（epoch ms） */
  t: number;
  /** 正規化したパス（/chat/:id など） */
  path: string;
  /** 遷移の所要時間（ms） */
  ms: number;
  /** ビルドID（git短縮SHA） */
  build: string;
  /** 端末（ブラウザのプロファイル）ごとの乱数 */
  deviceId: string;
  /** 端末の表示名（iPhone / Mac / Windows …） */
  device: string;
  /** ブラウザの表示名（Safari 18 など） */
  browser: string;
  /** standalone（ホーム画面から開いた全画面表示）か browser（タブ）か */
  mode: string;
}

const KEY = "chat-webui:perf";
const DEVICE_KEY = "chat-webui:perf-device";
/** 送れないまま溜め込む上限。溢れたら古いものから捨てる（控えなので） */
const MAX_SAMPLES = 1000;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60日
/** これだけ溜まったら、画面を閉じるのを待たずに送る */
export const FLUSH_THRESHOLD = 20;

/** 個別IDを含むパスをルートの形へ丸める（集計のキーにするため）。 */
export function normalizePath(pathname: string): string {
  return pathname
    .replace(/^\/chat\/[^/]+$/, "/chat/:id")
    .replace(/^\/bots\/[^/]+\/edit$/, "/bots/:id/edit");
}

export interface ClientInfo {
  deviceId: string;
  device: string;
  browser: string;
  mode: string;
}

/**
 * ブラウザの名乗りから、端末とブラウザの表示名を決める。
 *
 * 判定の順番が肝。Edge も Chrome も UA に "Safari" を含み、Edge の UA には
 * "Chrome" も入っている。**上から順に最初に当たったもの**を採るので、
 * 特殊なものほど先に置く。
 *
 * iPad の Safari は「Macintosh」と名乗る（デスクトップ表示が既定）。
 * 触れる点の数でしか見分けられないので、そこだけ別に見る。
 */
export function describeClient(input: {
  userAgent: string;
  standalone: boolean;
  maxTouchPoints?: number;
}): Omit<ClientInfo, "deviceId"> {
  const ua = input.userAgent;
  const touch = input.maxTouchPoints ?? 0;
  let device = "不明";
  if (/iPhone/.test(ua)) device = "iPhone";
  else if (/iPad/.test(ua)) device = "iPad";
  else if (/Android/.test(ua)) device = /Mobile/.test(ua) ? "Android" : "Android タブレット";
  else if (/Macintosh|Mac OS X/.test(ua)) device = touch > 1 ? "iPad" : "Mac";
  else if (/Windows/.test(ua)) device = "Windows";
  else if (/CrOS/.test(ua)) device = "ChromeOS";
  else if (/Linux/.test(ua)) device = "Linux";

  const BROWSERS: [string, RegExp][] = [
    ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
    ["Opera", /OPR\/(\d+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
    // Safari の版は "Version/18.0 … Safari/605" の側にある。iOS では
    // あいだに "Mobile/15E148" が挟まるので、そこを飛ばして読む
    ["Safari", /Version\/(\d+)[.\d]*[^)]*Safari/],
  ];
  let browser = "不明";
  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua);
    if (m) {
      browser = `${name} ${m[1]}`;
      break;
    }
  }
  if (browser === "不明" && /Safari/.test(ua)) browser = "Safari";

  return { device, browser, mode: input.standalone ? "standalone" : "browser" };
}

/** 端末ごとの乱数。無ければ作って残す（これが端末の同一性の全て）。 */
function deviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    if (saved) return saved;
    const made = crypto.randomUUID().slice(0, 8);
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    // localStorage が使えない（プライベート閲覧など）。この文書のあいだ
    // だけ有効な id を返す——記録は残るが、次に開くと別の端末に見える
    return "ephemeral";
  }
}

let cachedInfo: ClientInfo | null = null;

/** この文書を開いている環境。表示形態は開いたあと変わらないので1度でよい。 */
export function clientInfo(): ClientInfo {
  if (cachedInfo) return cachedInfo;
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone =
    nav.standalone === true ||
    (typeof matchMedia === "function" &&
      matchMedia("(display-mode: standalone)").matches);
  cachedInfo = {
    deviceId: deviceId(),
    ...describeClient({
      userAgent: navigator.userAgent,
      standalone,
      maxTouchPoints: navigator.maxTouchPoints,
    }),
  };
  return cachedInfo;
}

/** 未送信の控え。 */
export function loadSamples(): PerfSample[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PerfSample[];
    return Array.isArray(parsed) ? parsed.filter((s) => s && s.id) : [];
  } catch {
    return [];
  }
}

function save(samples: PerfSample[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(samples));
  } catch {
    // 記録できなくても画面には支障がない
  }
}

/** 記録する。戻り値は控えの件数（呼ぶ側が送り時を決めるため）。 */
export function recordNavigation(pathname: string, ms: number): number {
  try {
    const now = Date.now();
    const info = clientInfo();
    const samples = loadSamples()
      .filter((s) => now - s.t < MAX_AGE_MS)
      .slice(-(MAX_SAMPLES - 1));
    samples.push({
      id: crypto.randomUUID(),
      t: now,
      path: normalizePath(pathname),
      ms: Math.round(ms),
      build: __BUILD_ID__,
      deviceId: info.deviceId,
      device: info.device,
      browser: info.browser,
      mode: info.mode,
    });
    save(samples);
    return samples.length;
  } catch {
    return 0;
  }
}

/** 送り終えたものを控えから外す。送信中に増えた分は残る（id で消すため）。 */
export function dropSamples(ids: string[]): void {
  const gone = new Set(ids);
  save(loadSamples().filter((s) => !gone.has(s.id)));
}

export function clearSamples(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/**
 * 控えをサーバーへ送る。送れた件数を返す。
 *
 * 送信中に画面が閉じられても届くよう keepalive を付ける。失敗したら
 * 控えはそのまま残り、次の機会に送り直す——**成功を待たずに消すと、
 * 通信が切れた回のぶんだけ静かに欠ける**。
 */
export async function flushSamples(options: {
  fetchImpl?: typeof fetch;
  max?: number;
} = {}): Promise<number> {
  const doFetch = options.fetchImpl ?? fetch;
  const pending = loadSamples().slice(0, options.max ?? 200);
  if (pending.length === 0) return 0;
  try {
    const res = await doFetch("/api/perf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ samples: pending }),
      keepalive: true,
    });
    if (!res.ok) return 0;
    dropSamples(pending.map((s) => s.id));
    return pending.length;
  } catch {
    return 0;
  }
}

export function currentBuildId(): string {
  return __BUILD_ID__;
}

/* ------------------------------------------------------------------ *
 * サーバーから返ってきた集計の読み方
 * ------------------------------------------------------------------ */

/** ビルド（＝デプロイ）1つ。 */
export interface PerfBuild {
  build: string;
  firstAt: number;
  lastAt: number;
}

/** ビルド×切り口ごとの集計。 */
export interface PerfGroup {
  build: string;
  /** まとめに使った値（端末なら device_id、ページならパス、全体なら ""） */
  key: string;
  /** 画面に出す名前（端末は機種名） */
  label: string;
  count: number;
  median: number;
  p90: number;
  slowest: number;
  firstAt: number;
  lastAt: number;
}

/** 前回比。比べる相手がなければ null。 */
export function delta(
  cur: number,
  prev: number | undefined,
): { ms: number; pct: number } | null {
  if (prev == null || prev <= 0) return null;
  const ms = cur - prev;
  return { ms, pct: Math.round((ms / prev) * 100) };
}

export interface HistoryRow extends PerfGroup {
  /** 比較した相手のビルド（見つからなければ null）。 */
  prevBuild: string | null;
  prevMedian: number | null;
  prevP90: number | null;
}

/**
 * ビルドを新しい順に並べ、各行に「一つ前の記録」を添える。
 *
 * 比べる相手は**同じ切り口の値を持つ、次に古いビルド**。単純に1つ前の
 * ビルドとだけ比べていたときは、そのビルドでたまたまその端末を触って
 * いないと差が出せず、履歴が虫食いになった。iPhone の起動だけを追う、
 * のような読み方が成り立たなくなる。
 */
export function historyRows(
  builds: PerfBuild[],
  groups: PerfGroup[],
): { build: PerfBuild; rows: HistoryRow[] }[] {
  const order = builds.map((b) => b.build);
  const byBuild = new Map<string, PerfGroup[]>();
  for (const g of groups) {
    const list = byBuild.get(g.build) ?? [];
    list.push(g);
    byBuild.set(g.build, list);
  }
  return builds.map((b, i) => {
    const rows = (byBuild.get(b.build) ?? []).map((g) => {
      let prev: PerfGroup | undefined;
      for (let j = i + 1; j < order.length && !prev; j++) {
        prev = byBuild.get(order[j])?.find((p) => p.key === g.key);
      }
      return {
        ...g,
        prevBuild: prev?.build ?? null,
        prevMedian: prev?.median ?? null,
        prevP90: prev?.p90 ?? null,
      };
    });
    return { build: b, rows };
  });
}

/** 切り口の表示名（画面の選択肢とコピーの見出しで同じものを使う）。 */
export const DIMENSION_LABELS: Record<PerfDimension, string> = {
  none: "全体",
  path: "ページ別",
  device: "端末別",
  browser: "ブラウザ別",
  mode: "表示形態別",
};

/**
 * 行の名前。端末は短いIDを添える。
 *
 * 端末は乱数で分けているので、同じ機種を2台使っていると「Linux」が
 * 2行並ぶ。名前だけでは**どちらがどちらか分からない**まま、別物として
 * 数えられていることにも気づけない。
 */
export function rowLabel(dimension: PerfDimension, row: PerfGroup): string {
  if (dimension === "none") return "全体";
  if (dimension === "device") return `${row.label} #${row.key.slice(0, 4)}`;
  return row.label || "(不明)";
}

/** ページの絞り込みの見出し（コピーにも同じ文言を使う）。 */
export const ALL_PATHS_LABEL = "すべてのページ";

function formatDelta(cur: number, prev: number | null): string {
  const d = delta(cur, prev ?? undefined);
  if (!d) return "";
  const sign = d.ms > 0 ? "+" : "";
  return `（前回比 ${sign}${d.ms}ms / ${sign}${d.pct}%）`;
}

/** コピー用のプレーンテキスト。 */
export function formatHistory(
  history: { build: PerfBuild; rows: HistoryRow[] }[],
  dimension: PerfDimension,
  path?: string | null,
): string {
  const lines: string[] = [
    `Chat 起動・遷移の実測（${DIMENSION_LABELS[dimension]}・${path ?? ALL_PATHS_LABEL}）`,
  ];
  if (history.length === 0) lines.push("記録がありません");
  for (const { build, rows } of history) {
    lines.push(
      `${build.build === __BUILD_ID__ ? "＊" : " "} ${build.build}  ${new Date(build.firstAt).toLocaleString("ja-JP")} 〜 ${new Date(build.lastAt).toLocaleString("ja-JP")}`,
    );
    for (const r of rows) {
      const name = rowLabel(dimension, r);
      lines.push(
        `    ${name}  n=${r.count}  中央値 ${r.median}ms${formatDelta(r.median, r.prevMedian)}  p90 ${r.p90}ms${formatDelta(r.p90, r.prevP90)}  最遅 ${r.slowest}ms`,
      );
    }
  }
  return lines.join("\n");
}
