import type { Route } from "./+types/api.sidebar.move";
import { movePinnedItem } from "../lib/db.server";
import { apiError, requireMethod } from "../lib/api-types";

/** ピン留め一覧内の並べ替え（上下移動）。 */
export async function action({ request }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;
  let body: {
    type?: "conversation" | "folder";
    id?: string;
    direction?: "up" | "down";
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (
    (body.type !== "conversation" && body.type !== "folder") ||
    !body.id ||
    (body.direction !== "up" && body.direction !== "down")
  ) {
    return apiError("type / id / direction が不正です", 400);
  }
  await movePinnedItem(body.type, body.id, body.direction);
  return Response.json({ ok: true });
}
