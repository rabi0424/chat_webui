import type { Route } from "./+types/api.poe.bot-info";
import { POE_PREFIX, probePoeBot } from "../lib/openrouter.server";

/**
 * Poeボットの公開情報の確認（診断用）。
 *
 * 例: /api/poe/bot-info?bot=gpt-image-2
 *
 * そのボットが受け付けるパラメータ名を知る手段が公開APIに無いため、
 * Poeが実際に何を返しているかをここで確認する。⚙パネルの
 * 「ボット独自パラメータ」に何を入れればよいかの手がかりを得るのが目的。
 */
export async function loader({ request }: Route.LoaderArgs) {
  const raw = new URL(request.url).searchParams.get("bot")?.trim();
  if (!raw) {
    return Response.json(
      { error: "?bot=<ボット名> を付けてください（例: ?bot=gpt-image-2）" },
      { status: 400 },
    );
  }
  // モデルIDそのまま（poe:Name）でも、ボット名だけでも受け付ける
  const bot = raw.startsWith(POE_PREFIX) ? raw.slice(POE_PREFIX.length) : raw;

  return Response.json(
    { bot, results: await probePoeBot(bot) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
