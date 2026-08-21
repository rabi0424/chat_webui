import { fetchUsdJpy } from "../lib/fx.server";
import { storeUsdJpy } from "../lib/db.server";
import { apiJson, type FxResponse } from "../lib/api-types";

/**
 * USD/JPYレート。シェルの初回表示を軽くするため、ローダーではなく
 * クライアントから遅れて取る（lib/fx.server.ts のキャッシュは共用）。
 */
export async function loader() {
  const usdJpy = await fetchUsdJpy();
  // 上限の判定はこの値を使う。画面を開くたびに新しいものへ更新される
  if (usdJpy != null) await storeUsdJpy(usdJpy);
  return apiJson<FxResponse>(
    { usdJpy },
    { headers: { "Cache-Control": "private, max-age=3600" } },
  );
}
