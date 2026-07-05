import { fetchModels } from "../lib/openrouter.server";

export async function loader() {
  const models = await fetchModels();
  return Response.json(
    { models },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
