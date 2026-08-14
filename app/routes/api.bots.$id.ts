import type { Route } from "./+types/api.bots.$id";
import { deleteBot, getBot, updateBot } from "../lib/db.server";

interface BotBody {
  name?: string;
  icon?: string;
  modelId?: string;
  systemPrompt?: string;
  params?: Record<string, number> | null;
}

export async function action({ request, params }: Route.ActionArgs) {
  const bot = await getBot(params.id);
  if (!bot) {
    return Response.json({ error: "ボットが見つかりません" }, { status: 404 });
  }

  if (request.method === "DELETE") {
    await deleteBot(params.id);
    return Response.json({ ok: true });
  }

  if (request.method === "PUT") {
    let body: BotBody;
    try {
      body = (await request.json()) as BotBody;
    } catch {
      return Response.json({ error: "不正なリクエストです" }, { status: 400 });
    }
    if (!body.name?.trim() || !body.modelId) {
      return Response.json({ error: "name と modelId は必須です" }, { status: 400 });
    }
    await updateBot(params.id, {
      name: body.name.trim().slice(0, 60),
      icon: (body.icon ?? "🤖").slice(0, 8),
      modelId: body.modelId,
      systemPrompt: body.systemPrompt ?? "",
      paramsJson: body.params ? JSON.stringify(body.params) : null,
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Method Not Allowed" }, { status: 405 });
}
