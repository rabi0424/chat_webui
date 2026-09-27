import {
  useRouteLoaderData,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type { Route } from "./+types/chat.$id";
import { getConversationWithPath } from "../lib/db.server";
import { getCachedChat, pendingChat, putCachedChat } from "../lib/chat-cache";
import { toUiMessage } from "../lib/serialize.server";
import { parseParamsJson } from "../lib/params";
import {
  conversationTitle,
  SHELL_ROUTE_ID,
  type ShellTitles,
} from "../lib/conversation-title";
import { Chat } from "../components/Chat";

export function meta({ loaderData, matches }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Chat" }];
  // ヘッダーと同じ決め方（サイドバーで名前を変えたら、タブの名前も追う）
  const shell = matches.find((m) => m?.id === SHELL_ROUTE_ID)?.loaderData as
    | ShellTitles
    | undefined;
  return [{ title: `${conversationTitle(loaderData, shell)} - Chat` }];
}

/**
 * 同じ会話のままの取り直しでは、このローダーを走らせない。
 *
 * revalidator.revalidate() は、生成の終わり・サイドバーの操作・一覧が
 * 動いたことを未読の引き直しが見つけたとき（送信1通につき2回以上）に
 * 呼ばれ、既定では開いている画面のローダーも全部走り直す。ここは会話を
 * 丸ごと（全メッセージ）引くうえ、画面側は本文が動くたびに先読みの写しを
 * 捨てている（Chat.tsx）ので、ほぼ毎回サーバーまで行っていた。
 *
 * それでいて、受け取ったものはほとんど使われない。Chat は本文を
 * 開いた瞬間にしか読まず（以後は自分で追いかける）、key が会話IDなので
 * 作り直されもしない。効いていたのはタイトルだけで、それはシェルの
 * 会話一覧から取る（lib/conversation-title.ts）。
 *
 * 別の会話へ移るとき（:id が変わる）とフォームの送信は、これまでどおり
 * 既定に任せる。読み込みに失敗して例外の受け皿が出ているときは、
 * このルートのデータが無いので React Router がここを見ずに必ず走らせる
 * （受け皿の「再試行」は効く）。
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  // :id はパスそのものなので、パスが同じなら同じ会話
  if (formMethod == null && currentUrl.pathname === nextUrl.pathname) {
    return false;
  }
  return defaultShouldRevalidate;
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
  // 先読みが途中なら、それを待つ（同じ会話を丸ごと引く要求を2本並べない）。
  // 失敗・追い越し（null）のときだけ自分で取る
  const pending = pendingChat(params.id);
  if (pending) {
    const prefetched = await pending;
    if (prefetched) return prefetched;
  }
  const data = await serverLoader();
  putCachedChat(params.id, data);
  return data;
}

export default function ChatRoute({ loaderData }: Route.ComponentProps) {
  const { conversation, messages } = loaderData;
  const shell = useRouteLoaderData(SHELL_ROUTE_ID) as ShellTitles;
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
      title={conversationTitle(loaderData, shell)}
      initialParams={parseParamsJson(conversation.params_json)}
      // 作ったときの写し。あとで既定やボットを変えても遡らない
      systemPrompt={conversation.system_prompt}
    />
  );
}


// 例外の受け皿はこのルートに置く。root に任せると文書ごと
// 差し替わり、サイドバーまで消えて戻る導線が無くなる
export { RouteError as ErrorBoundary } from "../components/RouteError";
