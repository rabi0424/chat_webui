import { fetchUsdJpy } from "../lib/fx.server";
import { apiJson, type FxResponse } from "../lib/api-types";

/**
 * USD/JPYレート。シェルの初回表示を軽くするため、ローダーではなく
 * クライアントから遅れて取る（lib/fx.server.ts のキャッシュは共用）。
 */
export async function loader() {
  const usdJpy = await fetchUsdJpy();
  return apiJson<FxResponse>(
    { usdJpy },
    { headers: { "Cache-Control": "private, max-age=3600" } },
  );
}
