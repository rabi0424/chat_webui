import type { Route } from "./+types/api.folders.$id";
import { deleteFolder, updateFolder } from "../lib/db.server";
import { MAX_TITLE_LENGTH } from "../lib/constants";

export async function action({ request, params }: Route.ActionArgs) {
  // 削除は冪等に扱う。既に消えているものへの DELETE は、目的
  // （そのIDが無い状態）が達成されているので成功でよい
  if (request.method === "DELETE") {
    await deleteFolder(params.id);
    return Response.json({ ok: true });
  }
  if (request.method === "PATCH") {
    let body: { name?: string; pinned?: boolean };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "不正なリクエストです" }, { status: 400 });
    }
    const updated = await updateFolder(params.id, {
      name: body.name?.trim().slice(0, MAX_TITLE_LENGTH),
      pinned: body.pinned,
    });
    // 無いものを更新して成功を返すと、名前を変えたつもりが変わって
    // いない、という結果だけが残る
    if (!updated) {
      return Response.json(
        { error: "フォルダが見つかりません" },
        { status: 404 },
      );
    }
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Method Not Allowed" }, { status: 405 });
}
