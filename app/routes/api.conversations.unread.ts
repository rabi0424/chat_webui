import { listConversationFlags } from "../lib/db.server";
import { apiJson, type UnreadResponse } from "../lib/api-types";

/**
 * サイドバーの印（未読・生成中）。
 *
 * 応答はサーバー側で進むため、別の画面にいるあいだに完成しても
 * クライアントは気づけない。サイドバーはこれを短い間隔で引いて印を更新する。
 */
export async function loader() {
  const flags = await listConversationFlags();
  return apiJson<UnreadResponse>(
    {
      ids: flags.unread,
      generating: flags.generating,
      latest: flags.latest,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
