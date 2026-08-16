import type { Route } from "./+types/api.settings";
import { updateAppSettings } from "../lib/db.server";
import type { AppSettings } from "../lib/settings";

/** アプリ全体の設定の更新。 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "PATCH" && request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }
  let patch: Partial<AppSettings>;
  try {
    patch = (await request.json()) as Partial<AppSettings>;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  return Response.json({ settings: await updateAppSettings(patch) });
}
