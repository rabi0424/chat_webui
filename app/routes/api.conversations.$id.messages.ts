import type { Route } from "./+types/api.conversations.$id.messages";
import {
  appendUserMessage,
  getConversation,
  getMessage,
} from "../lib/db.server";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../lib/r2.server";
import {
  apiError,
  apiJson,
  requireMethod,
  type AppendMessageResponse,
} from "../lib/api-types";

/**
 * ユーザーの発言を保存する（生成はしない）。
 *
 * 編集の「保存」の行き先。書き直した文面を枝として残しておき、送るのは
 * 後から——という使い方のため、応答の生成とは別の入口にしてある
 * （生成の入口を通すと、必ず応答が1本走って課金される）。
 */
export async function action({ request, params }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;

  let body: {
    parentId?: string | null;
    content?: string;
    attachmentIds?: string[];
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("不正なリクエストです", 400);
  }

  const conversation = await getConversation(params.id);
  if (!conversation) return apiError("会話が見つかりません", 404);

  const content = (body.content ?? "").trim();
  const attachmentIds = Array.isArray(body.attachmentIds)
    ? body.attachmentIds.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
    : [];
  if (!content && attachmentIds.length === 0) {
    return apiError("本文か添付が必要です", 400);
  }

  /*
   * 繋ぎ先がこの会話のものか確かめる。確かめずに書くと、別の会話の
   * IDや消えたIDを渡されたときに**どこにも繋がっていない発言**が
   * できてしまう。木を辿る表示からは永久に見えないのに、行だけが残る。
   */
  const parentId = body.parentId ?? null;
  if (parentId && !(await getMessage(params.id, parentId))) {
    return apiError("繋ぎ先のメッセージが見つかりません", 404);
  }

  const id = await appendUserMessage({
    conversationId: params.id,
    parentId,
    content,
    attachmentIds,
  });
  return apiJson<AppendMessageResponse>({ id });
}
