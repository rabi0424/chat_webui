import type { Route } from "./+types/api.settings";
import { updateAppSettings } from "../lib/db.server";
import type { AppSettings } from "../lib/settings";
import { apiError, requireMethod } from "../lib/api-types";

/** アプリ全体の設定の更新。 */
export async function action({ request }: Route.ActionArgs) {
  const bad = requireMethod(request, ["PATCH"]);
  if (bad) return bad;
  let patch: Partial<AppSettings>;
  try {
    patch = (await request.json()) as Partial<AppSettings>;
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  return Response.json({ settings: await updateAppSettings(patch) });
}
