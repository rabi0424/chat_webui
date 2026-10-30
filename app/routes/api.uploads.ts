import type { Route } from "./+types/api.uploads";
import { createAttachment, sweepOrphanAttachments } from "../lib/db.server";
import { matchesDeclared } from "../lib/image-signature";
import { ALLOWED_ATTACHMENT_TYPES, PDF_TYPE } from "../lib/constants";
import {
  MAX_UPLOAD_BYTES,
  StorageUnavailableError,
  deleteFiles,
  isStorageConfigured,
  putFile,
} from "../lib/r2.server";
import { cloudflareContext } from "../lib/cloudflare-context";
import { apiError, apiJson, requireMethod, type UploadResponse } from "../lib/api-types";

/**
 * 添付（画像・PDF）のアップロード。R2へ実体を保存し、D1にメタデータ行を作って
 * 添付IDを返す。この時点ではまだどのメッセージにも属さず、
 * 送信時に `generate` がユーザーメッセージへ紐づける。
 */
export async function action({ request, context }: Route.ActionArgs) {
  const bad = requireMethod(request, ["POST"]);
  if (bad) return bad;
  if (!isStorageConfigured()) {
    return apiError(new StorageUnavailableError().message, 503);
  }

  let file: File | null = null;
  let pages: number | null;
  try {
    const form = await request.formData();
    const value = form.get("file");
    if (value instanceof File) file = value;
    pages = pagesOf(form.get("pages"));
  } catch {
    return apiError("不正なリクエストです", 400);
  }
  if (!file) {
    return apiError("file は必須です", 400);
  }

  const mimeType = declaredType(file);
  if (!ALLOWED_ATTACHMENT_TYPES.includes(mimeType)) {
    return apiError(
      `対応していない形式です（${ALLOWED_ATTACHMENT_TYPES.join(" / ")} のみ）`,
      415,
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return apiError(`ファイルが大きすぎます（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`, 413);
  }

  const buffer = await file.arrayBuffer();
  // 中身が申告どおりかを見る。ここまでの検査はブラウザの申告
  // （File.type）だけで、詐称すれば中身が画像でないものを画像として
  // 保存し、画像として配信できた
  if (!matchesDeclared(buffer, mimeType)) {
    return apiError(
      mimeType === PDF_TYPE
        ? "PDF として読めないファイルです"
        : "画像として読めないファイルです",
      415,
    );
  }
  // 実サイズも検証する（Content-Length は信用しない）
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    return apiError("ファイルが大きすぎます", 413);
  }

  const key = `attachments/${crypto.randomUUID()}`;
  try {
    await putFile(key, buffer, mimeType);
  } catch (e) {
    return apiError(`アップロードに失敗しました: ${(e as Error).message}`, 502);
  }

  let attachment;
  try {
    attachment = await createAttachment({
      r2Key: key,
      mimeType,
      name: file.name ? file.name.slice(0, 120) : null,
      size: buffer.byteLength,
      // 頁数は PDF にだけ意味がある（画像に付いてきても持たない）
      pages: mimeType === PDF_TYPE ? pages : null,
    });
  } catch (e) {
    // 実体だけ置いてメタデータを書けないと、どの行からも辿れない
    // 完全な孤児になる（孤児の掃除はDBの行を起点に探すので拾えない）
    await deleteFiles([key]).catch(() => {});
    return apiError(`アップロードに失敗しました: ${(e as Error).message}`, 500);
  }

  // 送信されないまま残った古い添付をついでに掃除する。
  // 応答を返したあとも走らせるため waitUntil に預ける（そのまま投げると
  // ランタイムに打ち切られ、掃除が実質走らないことがある）
  context.get(cloudflareContext).ctx.waitUntil(
    sweepOrphanAttachments().catch(() => {}),
  );

  return apiJson<UploadResponse>({
    id: attachment.id,
    mimeType: attachment.mime_type,
    name: attachment.name,
    size: attachment.size,
    pages: attachment.pages,
  });
}

/**
 * 端末が数えた PDF の頁数。
 *
 * 申告をそのまま信じる（使うのは OCR の見積もりだけで、課金は上流が
 * 実際の頁数で決める）。ただし数でないもの・あり得ない大きさは持たない
 * ——見積もりに「1e308 頁」と出ても困るだけなので、分からない扱いにする。
 */
function pagesOf(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return null;
  const n = Number(value);
  return n > 0 ? n : null;
}

/**
 * ブラウザが申告した形式。
 *
 * PDF は申告が空で届くことがある（OS に拡張子の登録が無い環境、
 * 一部のファイル共有アプリから渡したもの）。そのときだけ拡張子で補う。
 * 中身は後で `matchesDeclared` が確かめるので、名前を偽っても PDF で
 * ないものは通らない。
 */
function declaredType(file: File): string {
  const mime = file.type.split(";")[0].trim().toLowerCase();
  if (
    (mime === "" || mime === "application/octet-stream") &&
    file.name.toLowerCase().endsWith(".pdf")
  ) {
    return PDF_TYPE;
  }
  return mime;
}
