import type { Route } from "./+types/api.sidebar.move";
import { movePinnedItem } from "../lib/db.server";

/** ピン留め一覧内の並べ替え（上下移動）。 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }
  let body: {
    type?: "conversation" | "folder";
    id?: string;
    direction?: "up" | "down";
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  if (
    (body.type !== "conversation" && body.type !== "folder") ||
    !body.id ||
    (body.direction !== "up" && body.direction !== "down")
  ) {
    return Response.json({ error: "type / id / direction が不正です" }, { status: 400 });
  }
  await movePinnedItem(body.type, body.id, body.direction);
  return Response.json({ ok: true });
}
