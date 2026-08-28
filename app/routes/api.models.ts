import { fetchModels } from "../lib/openrouter.server";
import { apiError, apiJson, type ModelsResponse } from "../lib/api-types";

export async function loader() {
  // 失敗は §4 の決まりどおり {"error": 文言} の JSON で返す。以前は
  // fetchModels が投げた Response（プレーンテキストの 502）を素通し
  // していて、画面が理由を読めなかった（要件 §3.1「黙って済ませない」）
  let models;
  try {
    models = await fetchModels();
  } catch (e) {
    return apiError(
      e instanceof Error ? e.message : "モデル一覧の取得に失敗しました",
      502,
    );
  }
  return apiJson<ModelsResponse>(
    { models },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
