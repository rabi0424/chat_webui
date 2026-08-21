import type { Route } from "./+types/api.files.$id";
import { getAttachment } from "../lib/db.server";
import { getFile, isStorageConfigured } from "../lib/r2.server";

/**
 * 添付画像の配信。R2キーは外に出さず、添付IDで引く。
 * アプリ全体が Cloudflare Access の背後にあるため、ここでの追加認証は不要。
 */
export async function loader({ params }: Route.LoaderArgs) {
  if (!isStorageConfigured()) {
    return new Response("ストレージが設定されていません", { status: 503 });
  }
  const attachment = await getAttachment(params.id);
  if (!attachment) {
    return new Response("添付が見つかりません", { status: 404 });
  }
  const object = await getFile(attachment.r2_key);
  if (!object) {
    return new Response("ファイルの実体が見つかりません", { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": attachment.mime_type,
      /*
        中身の推測を止める。保存時にマジックナンバーを確かめてはいるが、
        それ以前に入った添付や、将来の抜けに備えて二枚にしておく。
        推測を許すと、画像として保存されたものがブラウザの判断で
        別のものとして扱われうる。
      */
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(attachment.size),
      // 添付は不変。個人利用なので共有キャッシュには載せない
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${encodeURIComponent(
        attachment.name ?? "image",
      )}"`,
    },
  });
}
