import type { Route } from "./+types/api.folders.$id";
import { deleteFolder, updateFolder } from "../lib/db.server";

export async function action({ request, params }: Route.ActionArgs) {
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
    await updateFolder(params.id, {
      name: body.name?.trim().slice(0, 60),
      pinned: body.pinned,
    });
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Method Not Allowed" }, { status: 405 });
}
