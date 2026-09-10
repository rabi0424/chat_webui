import type { Route } from "./+types/api.files.$id.thumb";
import { getAttachment, markThumbnail } from "../lib/db.server";
import { getFile, isStorageConfigured, putFile } from "../lib/r2.server";
import { apiError, apiJson, requireMethod } from "../lib/api-types";
import {
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_TYPES,
  thumbnailKeyOf,
} from "../lib/constants";
import { matchesDeclared } from "../lib/image-signature";

/**
 * 生成画像の縮小版（一覧のサムネイル）。
 *
 * 作るのはブラウザ（lib/thumbnail.ts）。原寸を最初に表示した端末が
 * 縮小して POST で置き、以後の一覧はこちらを読む。Workers でリサイズ
 * しない理由は constants.ts の THUMBNAIL_* を参照。
 */

/** 縮小版の配信。無ければ 404（一覧は thumb_at を見てから頼むので、ふつう来ない）。 */
export async function loader({ params }: Route.LoaderArgs) {
  if (!isStorageConfigured()) {
    return apiError("ストレージが設定されていません", 503);
  }
  const attachment = await getAttachment(params.id);
  if (!attachment) return apiError("添付が見つかりません", 404);
  const object = await getFile(thumbnailKeyOf(attachment.r2_key));
  if (!object) return apiError("縮小版がありません", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(object.size),
      // 置き直すことはあっても、URL は同じまま中身が変わるだけ。
      // 一覧は thumb_at が付いてから頼むので、無い状態は共有されない
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

/** 縮小版を置く。本文は WebP か JPEG の実体そのもの。 */
export async function action({ request, params }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;

  /*
   * 中身の検査はストレージに触る前に済ませる（バインディングに触らない
   * 経路として、テストで確かめられるように）。申告（Content-Type）は
   * 信用せず、先頭バイトで形式を確かめる——ここを通ったものは画像として
   * 配信されるので、画像のふりをした別のものを置かせない。
   */
  const mimeType = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!THUMBNAIL_TYPES.includes(mimeType)) {
    return apiError(
      `縮小版は ${THUMBNAIL_TYPES.join(" / ")} のみ受け付けます`,
      415,
    );
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > THUMBNAIL_MAX_BYTES) {
    return apiError("縮小版が大きすぎます", 413);
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > THUMBNAIL_MAX_BYTES) {
    return apiError("縮小版が大きすぎます", 413);
  }
  if (!matchesDeclared(buffer, mimeType)) {
    return apiError("画像として読めないファイルです", 415);
  }

  if (!isStorageConfigured()) {
    return apiError("ストレージが設定されていません", 503);
  }
  const attachment = await getAttachment(params.id);
  if (!attachment) return apiError("添付が見つかりません", 404);

  await putFile(thumbnailKeyOf(attachment.r2_key), buffer, mimeType);
  await markThumbnail(attachment.id, Date.now());
  return apiJson({ ok: true });
}
