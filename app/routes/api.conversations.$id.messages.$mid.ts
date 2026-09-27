import type { Route } from "./+types/api.conversations.$id.messages.$mid";
import { getMessage } from "../lib/db.server";
import { contentPayload, parseSince, reasoningPayload } from "../lib/polling";
import { isRetryProgress } from "../lib/retry";
import { parseCitations, parseUsage } from "../lib/serialize.server";
import { apiError, apiJson, type MessageStateResponse } from "../lib/api-types";

/**
 * ポーリング用: 生成中メッセージの現在状態を返す。
 *
 * `?since=<いま持っている長さ>` を付けると、その先だけを返す。追跡は
 * 400ms ごとに走るので、全文を毎回返していると長い応答ほど1回が重くなる
 * （§3.3）。差分で返してよい条件は `contentPayload` が持つ。
 *
 * 思考（reasoning）も `?rsince=` で同じように差分にする。考えるモデルでは
 * 思考のほうが本文より長く、本文だけ差分にしても重さの大半が残っていた。
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const message = await getMessage(params.id, params.mid);
  if (!message) {
    return apiError("メッセージが見つかりません", 404);
  }
  // 末尾に伸びていくだけなのは、生成中の本文だけ。「成功するまで生成」の
  // 見出しは毎秒書き直され、確定は本文を置き換えることがある。
  // 思考も同じ判定でよい: 生成中は届いた分を足すだけで、書き直すのは
  // 確定（と中断の掃除）——どちらも streaming を抜けるので全文になる。
  // 見出しの行は思考を持たない（null）ので、全文で返しても軽い
  const appendOnly =
    message.status === "streaming" && !isRetryProgress(message.content);
  return apiJson<MessageStateResponse>(
    {
      ...contentPayload(message.content, parseSince(request.url), appendOnly),
      ...reasoningPayload(
        message.reasoning,
        parseSince(request.url, "rsince"),
        appendOnly,
      ),
      status: message.status,
      error: message.error,
      usage: parseUsage(message.usage_json) ?? null,
      citations: parseCitations(message.citations_json) ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
