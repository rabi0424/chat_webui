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

/** コピー用のプレーンテキスト。 */
export function formatSummary(stats: BuildStat[]): string {
  const lines: string[] = ["Chat WebUI ページ遷移の実測（この端末）"];
  for (const b of stats) {
    lines.push(
      `\nビルド ${b.build}（最終記録 ${new Date(b.lastAt).toLocaleString("ja-JP")}、${b.total}件）`,
    );
    for (const r of b.routes) {
      lines.push(
        `  ${r.path}  n=${r.count}  中央値 ${r.median}ms  p90 ${r.p90}ms`,
      );
    }
  }
  return lines.join("\n");
}
