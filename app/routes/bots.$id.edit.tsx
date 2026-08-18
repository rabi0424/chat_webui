import { useOutletContext } from "react-router";
import type { Route } from "./+types/bots.$id.edit";
import type { ShellContext } from "./shell";
import { getBot } from "../lib/db.server";
import { BotForm } from "../components/BotForm";

export function meta({}: Route.MetaArgs) {
  return [{ title: "ボットを編集 - Chat WebUI" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const bot = await getBot(params.id);
  if (!bot) {
    throw new Response("ボットが見つかりません", { status: 404 });
  }
  return { bot };
}

export default function BotEdit({ loaderData }: Route.ComponentProps) {
  const { models, settings } = useOutletContext<ShellContext>();
  return (
    <div className="h-full overflow-y-auto">
      <BotForm
        models={models}
        initial={loaderData.bot}
        retryCeiling={settings.retryAttemptCeiling}
        newModelDays={settings.newModelDays}
      />
    </div>
  );
}
