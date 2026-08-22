import type { Route } from "./+types/api.folders";
import { createFolder } from "../lib/db.server";
import { MAX_TITLE_LENGTH } from "../lib/constants";
import { apiError, requireMethod } from "../lib/api-types";

export async function action({ request }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;
  let body: { name?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (!body.name?.trim()) {
    return apiError("name は必須です", 400);
  }
  const folder = await createFolder(body.name.trim().slice(0, MAX_TITLE_LENGTH));
  return Response.json({ folder });
}
