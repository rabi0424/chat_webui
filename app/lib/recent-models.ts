/**
 * よく使うモデルの記録（端末ごと・localStorage）。
 *
 * 「最近よく使っている」は頻度と新しさの両方で決める。使うたびにスコアへ
 * 1を加算し、前回使用からの経過時間で指数的に減衰させる。こうすると
 * 「昔は多用したが今は使っていない」モデルが自然に沈み、単純な使用回数
 * 順や最終使用日時順のどちらよりも実感に近い並びになる。
 *
 * 下書きや選択中モデルと同じく端末ローカルに持つ（サーバーには送らない）。
 * 会話履歴から集計すれば端末をまたげるが、モデル一覧の描画のたびに
 * 集計クエリが要るため、まずは端末ごとの記録で運用する。
 */

const STORAGE_KEY = "chat-webui:model-usage";
/** スコアが半分になるまでの日数。 */
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** 保持する件数。これを超えたらスコアの低いものから捨てる。 */
const MAX_ENTRIES = 30;

interface UsageEntry {
  /** 減衰後のスコア（usedAt 時点の値）。 */
  score: number;
  /** 最終使用時刻。減衰の起点。 */
  usedAt: number;
}

type UsageMap = Record<string, UsageEntry>;

/** usedAt 時点のスコアを now 時点まで減衰させる。 */
function decayed(entry: UsageEntry, now: number): number {
  const elapsed = now - entry.usedAt;
  if (!(elapsed > 0)) return entry.score;
  return entry.score * Math.pow(0.5, elapsed / HALF_LIFE_MS);
}

/** 壊れた値・別バージョンの残骸は空として扱う（記録は失っても困らない）。 */
function read(): UsageMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: UsageMap = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<UsageEntry> | null;
      if (
        e &&
        typeof e.score === "number" &&
        Number.isFinite(e.score) &&
        e.score > 0 &&
        typeof e.usedAt === "number" &&
        Number.isFinite(e.usedAt)
      ) {
        out[id] = { score: e.score, usedAt: e.usedAt };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** モデルを1回使ったことを記録する。生成の開始ごとに呼ぶ。 */
export function recordModelUse(modelId: string, now = Date.now()): void {
  if (!modelId) return;
  try {
    const map = read();
    const prev = map[modelId];
    map[modelId] = {
      score: (prev ? decayed(prev, now) : 0) + 1,
      usedAt: now,
    };

    const kept = Object.entries(map)
      .sort((a, b) => decayed(b[1], now) - decayed(a[1], now))
      .slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // プライベートモード等で保存できなくても生成は妨げない
  }
}

/** よく使う順のモデルID。存在しないIDも混じりうるので呼び出し側で照合する。 */
export function rankedModelIds(now = Date.now()): string[] {
  const map = read();
  return Object.entries(map)
    .sort((a, b) => decayed(b[1], now) - decayed(a[1], now))
    .map(([id]) => id);
}
