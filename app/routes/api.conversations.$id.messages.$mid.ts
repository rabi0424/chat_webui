import type { Route } from "./+types/api.conversations.$id.messages.$mid";
import { getMessage } from "../lib/db.server";
import { parseCitations, parseUsage } from "../lib/serialize.server";
import { apiJson, type MessageStateResponse } from "../lib/api-types";

/** ポーリング用: 生成中メッセージの現在状態を返す。 */
export async function loader({ params }: Route.LoaderArgs) {
  const message = await getMessage(params.id, params.mid);
  if (!message) {
    return Response.json({ error: "メッセージが見つかりません" }, { status: 404 });
  }
  return apiJson<MessageStateResponse>(
    {
      content: message.content,
      reasoning: message.reasoning,
      status: message.status,
      error: message.error,
      usage: parseUsage(message.usage_json) ?? null,
      citations: parseCitations(message.citations_json) ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
