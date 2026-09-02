import type { Route } from "./+types/chat.$id";
import { getConversationWithPath } from "../lib/db.server";
import { getCachedChat, putCachedChat } from "../lib/chat-cache";
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

/**
 * サイドバーの先読み（chat-cache）があればサーバーを待たずに即返す。
 * なければ通常どおり取得し、直近の再訪に備えて書き込んでおく。
 */
export async function clientLoader({
  params,
  serverLoader,
}: Route.ClientLoaderArgs) {
  const cached = getCachedChat(params.id);
  if (cached) return cached;
  const data = await serverLoader();
  putCachedChat(params.id, data);
  return data;
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
      title={conversation.title}
      initialParams={parseParamsJson(conversation.params_json)}
      // 作ったときの写し。あとで既定やボットを変えても遡らない
      systemPrompt={conversation.system_prompt}
    />
  );
}


// 例外の受け皿はこのルートに置く。root に任せると文書ごと
// 差し替わり、サイドバーまで消えて戻る導線が無くなる
export { RouteError as ErrorBoundary } from "../components/RouteError";
