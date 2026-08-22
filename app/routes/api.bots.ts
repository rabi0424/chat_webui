import type { Route } from "./+types/api.bots";
import { createBot, listBots } from "../lib/db.server";
import { MAX_TITLE_LENGTH } from "../lib/constants";
import type { ParamsState } from "../lib/params";
import { apiError, requireMethod } from "../lib/api-types";

export async function loader() {
  const bots = await listBots();
  return Response.json({ bots });
}

interface BotBody {
  name?: string;
  icon?: string;
  modelId?: string;
  systemPrompt?: string;
  params?: ParamsState | null;
}

export async function action({ request }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;
  let body: BotBody;
  try {
    body = (await request.json()) as BotBody;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (!body.name?.trim() || !body.modelId) {
    return apiError("name と modelId は必須です", 400);
  }

  const bot = await createBot({
    name: body.name.trim().slice(0, MAX_TITLE_LENGTH),
    icon: (body.icon ?? "🤖").slice(0, 8),
    modelId: body.modelId,
    systemPrompt: body.systemPrompt ?? "",
    paramsJson: body.params ? JSON.stringify(body.params) : null,
  });
  return Response.json({ bot });
}
