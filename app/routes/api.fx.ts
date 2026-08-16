import { fetchUsdJpy } from "../lib/fx.server";

/**
 * USD/JPYレート。シェルの初回表示を軽くするため、ローダーではなく
 * クライアントから遅れて取る（lib/fx.server.ts のキャッシュは共用）。
 */
export async function loader() {
  const usdJpy = await fetchUsdJpy();
  return Response.json(
    { usdJpy },
    { headers: { "Cache-Control": "private, max-age=3600" } },
  );
}
