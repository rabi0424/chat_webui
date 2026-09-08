import type { Route } from "./+types/api.generations.stop-all";
import { stopAllGenerations } from "../lib/db.server";
import { apiJson, requireMethod } from "../lib/api-types";

/**
 * 走っている生成をすべて止める。
 *
 * 実行体（Durable Object）のアラームは外から消せない。枠を使い切って
 * 締め出されているあいだに溜まったアラームは、枠が戻った瞬間に一斉に
 * 動き出す——実際にそれで、戻ってから30分でまた1日分を使い切った。
 * 司令役は毎秒この停止の印を見るので、ここを立てれば新しく起こすのが
 * 止まる（走り出している担当は最後まで受け取る。課金済みのため）。
 */
export async function action({ request }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;
  return apiJson({ stopped: await stopAllGenerations() });
}
