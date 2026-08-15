import type { Route } from "./+types/api.uploads";
import { createAttachment, sweepOrphanAttachments } from "../lib/db.server";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  StorageUnavailableError,
  isStorageConfigured,
  putFile,
} from "../lib/r2.server";

/**
 * 画像のアップロード。R2へ実体を保存し、D1にメタデータ行を作って
 * 添付IDを返す。この時点ではまだどのメッセージにも属さず、
 * 送信時に `generate` がユーザーメッセージへ紐づける。
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }
  if (!isStorageConfigured()) {
    return Response.json(
      { error: new StorageUnavailableError().message },
      { status: 503 },
    );
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("file");
    if (value instanceof File) file = value;
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  if (!file) {
    return Response.json({ error: "file は必須です" }, { status: 400 });
  }

  const mimeType = file.type.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
    return Response.json(
      {
        error: `対応していない形式です（${ALLOWED_IMAGE_TYPES.join(" / ")} のみ）`,
      },
      { status: 415 },
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: `ファイルが大きすぎます（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）` },
      { status: 413 },
    );
  }

  const buffer = await file.arrayBuffer();
  // 実サイズも検証する（Content-Length は信用しない）
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "ファイルが大きすぎます" }, { status: 413 });
  }

  const key = `attachments/${crypto.randomUUID()}`;
  try {
    await putFile(key, buffer, mimeType);
  } catch (e) {
    return Response.json(
      { error: `アップロードに失敗しました: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const attachment = await createAttachment({
    r2Key: key,
    mimeType,
    name: file.name ? file.name.slice(0, 120) : null,
    size: buffer.byteLength,
  });

  // 送信されないまま残った古い添付をついでに掃除する
  void sweepOrphanAttachments().catch(() => {});

  return Response.json({
    id: attachment.id,
    mimeType: attachment.mime_type,
    name: attachment.name,
    size: attachment.size,
  });
}
