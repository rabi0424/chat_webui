import { env } from "cloudflare:workers";

/**
 * 添付ファイルの実体ストレージ（Cloudflare R2）。
 *
 * メタデータはD1の attachments テーブルが持ち、ここではキー単位の
 * 読み書きだけを扱う。バケット未設定の環境（バインディング無し）でも
 * アプリ全体が落ちないよう、呼び出し側が扱えるエラーに変換する。
 */

/** 画像として受け入れるMIMEタイプ。LLM各社が共通で扱える形式に限定する。 */
export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** 1ファイルあたりの上限。これ以上はクライアント側で縮小してから送る。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 1メッセージに添付できる枚数の上限。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

export class StorageUnavailableError extends Error {
  constructor() {
    super(
      "添付ファイル用のR2バケットが設定されていません（wrangler.jsonc の FILES バインディングとバケット作成を確認してください）",
    );
  }
}

function bucket(): R2Bucket {
  if (!env.FILES) throw new StorageUnavailableError();
  return env.FILES;
}

export function isStorageConfigured(): boolean {
  return Boolean(env.FILES);
}

export async function putFile(
  key: string,
  body: ArrayBuffer,
  mimeType: string,
): Promise<void> {
  await bucket().put(key, body, {
    httpMetadata: { contentType: mimeType },
  });
}

export async function getFile(key: string): Promise<R2ObjectBody | null> {
  return await bucket().get(key);
}

export async function deleteFiles(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await bucket().delete(keys);
  } catch {
    // 実体の削除に失敗してもメタデータの削除は成立させる（孤児は無害）
  }
}

/** data: URL 用のbase64化。大きな画像でもスタックを溢れさせないよう分割する。 */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
