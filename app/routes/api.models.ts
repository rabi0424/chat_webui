import { fetchModels } from "../lib/openrouter.server";
import { apiJson, type ModelsResponse } from "../lib/api-types";

export async function loader() {
  const models = await fetchModels();
  return apiJson<ModelsResponse>(
    { models },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
