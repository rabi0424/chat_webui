import type { Route } from "./+types/api.bots.$id";
import { deleteBot, getBot, updateBot } from "../lib/db.server";
import { MAX_TITLE_LENGTH } from "../lib/constants";
import type { ParamsState } from "../lib/params";
import { apiError, requireMethod } from "../lib/api-types";

interface BotBody {
  name?: string;
  icon?: string;
  modelId?: string;
  systemPrompt?: string;
  params?: ParamsState | null;
}

export async function action({ request, params }: Route.ActionArgs) {
  // 扱えるメソッドかを先に見る。存在の確認を先にすると、知らない
  // メソッドで存在しないIDを叩いたときに 405 ではなく 404 が返り、
  // 「そのIDが無い」のか「その操作ができない」のか区別が付かない
  const bad = requireMethod(request, ["PATCH", "DELETE"]);
  if (bad) return bad;

  const bot = await getBot(params.id);
  if (!bot) {
    return apiError("ボットが見つかりません", 404);
  }

  if (request.method === "DELETE") {
    await deleteBot(params.id);
    return Response.json({ ok: true });
  }

  // ここまで来たら PATCH（他は上で弾いている）
  let body: BotBody;
  try {
    body = (await request.json()) as BotBody;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (!body.name?.trim() || !body.modelId) {
    return apiError("name と modelId は必須です", 400);
  }
  await updateBot(params.id, {
    name: body.name.trim().slice(0, MAX_TITLE_LENGTH),
    icon: (body.icon ?? "🤖").slice(0, 8),
    modelId: body.modelId,
    systemPrompt: body.systemPrompt ?? "",
    paramsJson: body.params ? JSON.stringify(body.params) : null,
  });
  return Response.json({ ok: true });
  

}
