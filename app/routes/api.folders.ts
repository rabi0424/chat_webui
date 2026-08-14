import type { Route } from "./+types/api.folders";
import { createFolder } from "../lib/db.server";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }
  let body: { name?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  if (!body.name?.trim()) {
    return Response.json({ error: "name は必須です" }, { status: 400 });
  }
  const folder = await createFolder(body.name.trim().slice(0, 60));
  return Response.json({ folder });
}
