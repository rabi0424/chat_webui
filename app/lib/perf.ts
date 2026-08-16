/**
 * ページ遷移の所要時間の記録（この端末のみ）。
 *
 * 遷移のたびに「タップ〜画面切り替わり」の実測をlocalStorageへ貯める。
 * サンプルにはビルドID（gitの短縮SHA）が付くので、デプロイをまたいだ
 * 前後比較が手作業なしでできる。設定画面の「パフォーマンス」に集計を
 * 表示し、ワンタップでコピーできるようにする。
 */

export interface PerfSample {
  /** 記録時刻（epoch ms） */
  t: number;
  /** 正規化したパス（/chat/:id など） */
  path: string;
  /** 遷移の所要時間（ms） */
  ms: number;
  /** ビルドID（git短縮SHA） */
  build: string;
}

const KEY = "chat-webui:perf";
const MAX_SAMPLES = 1000;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60日

/** 個別IDを含むパスをルートの形へ丸める（集計のキーにするため）。 */
export function normalizePath(pathname: string): string {
  return pathname
    .replace(/^\/chat\/[^/]+$/, "/chat/:id")
    .replace(/^\/bots\/[^/]+\/edit$/, "/bots/:id/edit");
}

export function loadSamples(): PerfSample[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PerfSample[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordNavigation(pathname: string, ms: number): void {
  try {
    const now = Date.now();
    const samples = loadSamples()
      .filter((s) => now - s.t < MAX_AGE_MS)
      .slice(-(MAX_SAMPLES - 1));
    samples.push({
      t: now,
      path: normalizePath(pathname),
      ms: Math.round(ms),
      build: __BUILD_ID__,
    });
    localStorage.setItem(KEY, JSON.stringify(samples));
  } catch {
    // 記録できなくても遷移自体に支障はない
  }
}

export function clearSamples(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)];
}

export interface RouteStat {
  path: string;
  count: number;
  median: number;
  p90: number;
}

export interface BuildStat {
  build: string;
  /** このビルドで最後に記録した時刻 */
  lastAt: number;
  routes: RouteStat[];
  total: number;
}

/** ビルドごと（新しい順）→ ルートごと（件数順）に集計する。 */
export function summarize(samples: PerfSample[]): BuildStat[] {
  const byBuild = new Map<string, PerfSample[]>();
  for (const s of samples) {
    const list = byBuild.get(s.build) ?? [];
    list.push(s);
    byBuild.set(s.build, list);
  }
  return [...byBuild.entries()]
    .map(([build, list]) => {
      const byPath = new Map<string, number[]>();
      for (const s of list) {
        const arr = byPath.get(s.path) ?? [];
        arr.push(s.ms);
        byPath.set(s.path, arr);
      }
      const routes = [...byPath.entries()]
        .map(([path, arr]) => {
          const sorted = [...arr].sort((a, b) => a - b);
          return {
            path,
            count: sorted.length,
            median: percentile(sorted, 50),
            p90: percentile(sorted, 90),
          };
        })
        .sort((a, b) => b.count - a.count);
      return {
        build,
        lastAt: Math.max(...list.map((s) => s.t)),
        routes,
        total: list.length,
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

export interface BuildComparison {
  /** いま動いているビルドの集計（記録がなければ null）。 */
  current: BuildStat | null;
  /** 比較対象: 現行以外で最後に記録のあったビルド。 */
  previous: BuildStat | null;
}

/**
 * 表示は常に「現行ビルド vs 直前のビルド」。デプロイでビルドIDが
 * 変わると current が新しい方へ自動で切り替わり、それまでの数字は
 * previous 側として比較に使われる。
 */
export function compareLatest(samples: PerfSample[]): BuildComparison {
  const stats = summarize(samples);
  return {
    current: stats.find((b) => b.build === __BUILD_ID__) ?? null,
    // summarize は新しい順なので、最初に見つかる別ビルドが「前回」
    previous: stats.find((b) => b.build !== __BUILD_ID__) ?? null,
  };
}

export function currentBuildId(): string {
  return __BUILD_ID__;
}

/** 前回比。previous に同じページの記録がなければ null。 */
export function delta(
  cur: number,
  prev: number | undefined,
): { ms: number; pct: number } | null {
  if (prev == null || prev <= 0) return null;
  const ms = cur - prev;
  return { ms, pct: Math.round((ms / prev) * 100) };
}

function formatDelta(cur: number, prev: number | undefined): string {
  const d = delta(cur, prev);
  if (!d) return "";
  const sign = d.ms > 0 ? "+" : "";
  return `（前回比 ${sign}${d.ms}ms / ${sign}${d.pct}%）`;
}

/** コピー用のプレーンテキスト。 */
export function formatComparison(c: BuildComparison): string {
  const lines: string[] = ["Chat WebUI ページ遷移の実測（この端末）"];
  if (!c.current) {
    lines.push(`現行ビルド ${__BUILD_ID__} の記録はまだありません`);
  } else {
    lines.push(
      `現行ビルド ${c.current.build}（${c.current.total}件・最終 ${new Date(c.current.lastAt).toLocaleString("ja-JP")}）`,
    );
    if (c.previous) {
      lines.push(
        `前回ビルド ${c.previous.build}（${c.previous.total}件）との比較`,
      );
    }
    for (const r of c.current.routes) {
      const prev = c.previous?.routes.find((p) => p.path === r.path);
      lines.push(
        `  ${r.path}  n=${r.count}  中央値 ${r.median}ms${formatDelta(r.median, prev?.median)}  p90 ${r.p90}ms${formatDelta(r.p90, prev?.p90)}`,
      );
    }
  }
  return lines.join("\n");
}
