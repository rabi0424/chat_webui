/**
 * 為替レート（USD/JPY）の取得。
 *
 * 生成コストの円建て表示に使う。open.er-api.com の無料エンドポイント
 * （キー不要・日次更新）から取得し、モジュールレベルでキャッシュする。
 * 取得失敗時は古いキャッシュを返し、それも無ければ null
 * （呼び出し側はドル建て表示にフォールバックする）。
 */

const FX_BASE = "https://open.er-api.com";

const FX_TTL_MS = 12 * 60 * 60 * 1000; // レートは日次更新なので半日で十分

let fxCache: { rate: number; fetchedAt: number } | null = null;

export async function fetchUsdJpy(): Promise<number | null> {
  if (fxCache && Date.now() - fxCache.fetchedAt < FX_TTL_MS) {
    return fxCache.rate;
  }
  try {
    const res = await fetch(`${FX_BASE}/v6/latest/USD`, {
      signal: AbortSignal.timeout(3000), // 画面表示を遅らせない
    });
    if (!res.ok) return fxCache?.rate ?? null;
    const body = (await res.json()) as { rates?: Record<string, number> };
    const rate = body.rates?.JPY;
    if (typeof rate === "number" && rate > 0) {
      fxCache = { rate, fetchedAt: Date.now() };
      return rate;
    }
    return fxCache?.rate ?? null;
  } catch {
    return fxCache?.rate ?? null;
  }
}
