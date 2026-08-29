import type { Route } from "./+types/api.conversations.$id.path";
import {
  getConversation,
  getConversationPath,
  switchToBranch,
} from "../lib/db.server";
import { toUiMessage } from "../lib/serialize.server";
import { pathFingerprint } from "../lib/polling";
import { apiError, apiJson, requireMethod, type PathResponse } from "../lib/api-types";

/**
 * 表示中のパスは生成のたびに変わる。中間キャッシュに残さない。
 */
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * @param ifNoneMatch 前回受け取った札。中身が変わっていなければ 304 で返す
 */
async function pathResponse(
  id: string,
  ifNoneMatch?: string | null,
): Promise<Response> {
  const conversation = await getConversation(id);
  if (!conversation) return apiError("会話が見つかりません", 404);
  const path = await getConversationPath(conversation);
  /*
   * 「成功するまで生成」の追跡は1秒ごとにここを叩く。積み上がった成功の
   * 本文まで毎回運ぶので、実行が長引くほど重くなる。中身が変わっていない
   * ことを札で伝えられれば、本文はまるごと省ける（D1を読む分は変わらない）。
   */
  const etag = pathFingerprint(path);
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, ...NO_STORE.headers },
    });
  }
  return apiJson<PathResponse>({ messages: path.map(toUiMessage) }, {
    headers: { ...NO_STORE.headers, ETag: etag },
  });
}

/** GET: 現在表示中のパスを返す（ページャ情報付き）。 */
export async function loader({ request, params }: Route.LoaderArgs) {
  return await pathResponse(params.id, request.headers.get("If-None-Match"));
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
