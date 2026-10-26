import type { Route } from "./+types/api.bots";
import { createBot, getBot, listBots } from "../lib/db.server";
import { botFilesJson, sanitizeBotFiles } from "../lib/bot-files";
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
  /** 添付ファイル（`lib/bot-files.ts`）。 */
  files?: unknown;
  /**
   * 複製のとき、ファイルを写す元のボット。一覧（シェル）はファイルの
   * 中身を持たないので、画面からは送れない。
   */
  filesFrom?: string;
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

  let filesJson = botFilesJson(sanitizeBotFiles(body.files));
  if (body.files === undefined && typeof body.filesFrom === "string") {
    filesJson = (await getBot(body.filesFrom))?.files_json ?? null;
  }

  const bot = await createBot({
    name: body.name.trim().slice(0, MAX_TITLE_LENGTH),
    icon: (body.icon ?? "🤖").slice(0, 8),
    modelId: body.modelId,
    systemPrompt: body.systemPrompt ?? "",
    paramsJson: body.params ? JSON.stringify(body.params) : null,
    filesJson,
  });
  return Response.json({ bot });
}
