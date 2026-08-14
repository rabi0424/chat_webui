import type { Route } from "./+types/chat.$id";
import { getConversation, getConversationPath } from "../lib/db.server";
import { toUiMessage } from "../lib/serialize.server";
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
  const conversation = await getConversation(params.id);
  if (!conversation) {
    throw new Response("会話が見つかりません", { status: 404 });
  }
  const path = await getConversationPath(conversation);
  return { conversation, messages: path.map(toUiMessage) };
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
          params: conversation.params_json
            ? JSON.parse(conversation.params_json)
            : null,
        }
      : null;
  return (
    <Chat
      key={conversation.id}
      conversationId={conversation.id}
      initialMessages={messages}
      bot={bot}
      initialModel={conversation.model_id}
    />
  );
}
