import type { Route } from "./+types/api.folders.$id";
import { deleteFolder, updateFolder } from "../lib/db.server";
import { MAX_TITLE_LENGTH } from "../lib/constants";
import { apiError, requireMethod } from "../lib/api-types";

export async function action({ request, params }: Route.ActionArgs) {
  const bad = requireMethod(request, ["PATCH", "DELETE"]);
  if (bad) return bad;

  // 削除は冪等に扱う。既に消えているものへの DELETE は、目的
  // （そのIDが無い状態）が達成されているので成功でよい
  if (request.method === "DELETE") {
    await deleteFolder(params.id);
    return Response.json({ ok: true });
  }
  // ここまで来たら PATCH（他は上で弾いている）
  let body: { name?: string; pinned?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  const updated = await updateFolder(params.id, {
    name: body.name?.trim().slice(0, MAX_TITLE_LENGTH),
    pinned: body.pinned,
  });
  // 無いものを更新して成功を返すと、名前を変えたつもりが変わって
  // いない、という結果だけが残る
  if (!updated) {
    return apiError("フォルダが見つかりません", 404);
  }
  return Response.json({ ok: true });
}
