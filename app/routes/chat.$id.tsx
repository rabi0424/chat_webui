import type { Route } from "./+types/chat.$id";
import { getConversationWithPath } from "../lib/db.server";
import { toUiMessage } from "../lib/serialize.server";
import { parseParamsJson } from "../lib/params";
import { Chat } from "../components/Chat";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData
        ? `${loaderData.conversation.title} - Chat WebUI`
        : "Chat WebUI",
    },
  ];
}

export async function loader({ params }: Route.LoaderArgs) {
  const started = Date.now();
  const found = await getConversationWithPath(params.id);
  if (!found) {
    throw new Response("会話が見つかりません", { status: 404 });
  }
  // 遷移の体感を数字で追うための実測。wrangler tail かダッシュボードのログで見る
  console.log(
    `[perf] chat/:id loader ${Date.now() - started}ms (messages=${found.path.length})`,
  );
  return {
    conversation: found.conversation,
    messages: found.path.map(toUiMessage),
  };
}

export default function ChatRoute({ loaderData }: Route.ComponentProps) {
  const { conversation, messages } = loaderData;
  const bot =
    conversation.bot_name != null
      ? {
          id: conversation.bot_id,
          name: conversation.bot_name,
          icon: conversation.bot_icon ?? "🤖",
          systemPrompt: conversation.system_prompt,
          params: null,
        }
      : null;
  return (
    <Chat
      key={conversation.id}
      conversationId={conversation.id}
      initialMessages={messages}
      bot={bot}
      initialModel={conversation.model_id}
      initialParams={parseParamsJson(conversation.params_json)}
    />
  );
}
