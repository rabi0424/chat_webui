import type { Route } from "./+types/api.conversations.$id.path";
import {
  getConversation,
  getConversationPath,
  switchToBranch,
} from "../lib/db.server";
import { toUiMessage } from "../lib/serialize.server";
import { apiError, apiJson, requireMethod, type PathResponse } from "../lib/api-types";

/**
 * 表示中のパスは生成のたびに変わる。中間キャッシュに残さない。
 */
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

async function pathResponse(id: string): Promise<Response> {
  const conversation = await getConversation(id);
  if (!conversation) return apiError("会話が見つかりません", 404);
  const path = await getConversationPath(conversation);
  return apiJson<PathResponse>(
    { messages: path.map(toUiMessage) },
    NO_STORE,
  );
}

/** GET: 現在表示中のパスを返す（ページャ情報付き）。 */
export async function loader({ params }: Route.LoaderArgs) {
  return await pathResponse(params.id);
}

/** POST: 指定メッセージのブランチへ切り替え、新しいパスを返す。 */
export async function action({ request, params }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;
  let body: { messageId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (!body.messageId) return apiError("messageId は必須です", 400);

  const conversation = await getConversation(params.id);
  if (!conversation) return apiError("会話が見つかりません", 404);

  const ok = await switchToBranch(conversation, body.messageId);
  if (!ok) return apiError("メッセージが見つかりません", 404);

  // 切り替えた結果をもう一度読む。ここで会話が消えていることもある
  // （別のタブで削除された等）ので、非nullとは決めつけない
  return await pathResponse(params.id);
}
