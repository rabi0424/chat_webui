import type { Route } from "./+types/api.conversations.$id.path";
import {
  getConversation,
  getConversationPathTag,
  getConversationWithPath,
  switchToBranch,
} from "../lib/db.server";
import { toUiMessage } from "../lib/serialize.server";
import {
  encodeRunProgress,
  pathFingerprint,
  RUN_PROGRESS_HEADER,
} from "../lib/polling";
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
  /*
   * 札を持って来たときは、まず本文を読まずに札だけを作る（1往復）。
   * 「成功するまで生成」の追跡は毎秒ここを叩き、その大半は何も変わって
   * いない。以前は札を作るために会話・全枝の本文・添付を直列に読んで
   * いたので、304 で返せても D1 の往復と転送は丸ごと残っていた。
   * 変わっていたときだけ本文を読む（もう1往復）。札を持って来ない呼び出し
   * （初回・枝の切り替え）は、札だけを読むのが無駄なので直接本文へ行く。
   */
  if (ifNoneMatch) {
    const tag = await getConversationPathTag(id);
    if (!tag) return apiError("会話が見つかりません", 404);
    if (tag.etag && tag.etag === ifNoneMatch) {
      const headers: Record<string, string> = {
        ETag: tag.etag,
        ...NO_STORE.headers,
      };
      // 札は見出しの進捗を見ないので、進捗だけはここで添える
      if (tag.progress) {
        headers[RUN_PROGRESS_HEADER] = encodeRunProgress(tag.progress);
      }
      return new Response(null, { status: 304, headers });
    }
  }
  const found = await getConversationWithPath(id);
  if (!found) return apiError("会話が見つかりません", 404);
  const etag = pathFingerprint(found.path);
  return apiJson<PathResponse>({ messages: found.path.map(toUiMessage) }, {
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
