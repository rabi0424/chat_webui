import type { Route } from "./+types/chat.$id";
import { getConversation, getConversationPath } from "../lib/db.server";
import { Chat, type UiMessage } from "../components/Chat";

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
  const messages: UiMessage[] = path.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    usage: m.usage_json ? JSON.parse(m.usage_json) : undefined,
  }));
  return { conversation, messages };
}

export default function ChatRoute({ loaderData }: Route.ComponentProps) {
  const { conversation, messages } = loaderData;
  return (
    <Chat
      key={conversation.id}
      conversationId={conversation.id}
      initialMessages={messages}
    />
  );
}
