/**
 * 送信前の画像処理（クライアント側）。
 *
 * 画像はトークン単価に直結し、data: URL として丸ごとプロンプトに載る。
 * 長辺を抑えて再エンコードするだけで、認識精度をほぼ落とさずに
 * 転送量とコストを大きく減らせるため、送信前に必ず通す。
 */

/** 長辺の上限。これを超える画像だけ縮小する。 */
const MAX_EDGE = 2048;

/** これ以下のサイズなら再エンコードせずそのまま送る。 */
const REENCODE_THRESHOLD_BYTES = 512 * 1024;

import { ALLOWED_IMAGE_TYPES, PDF_TYPE } from "./constants";

export function isAcceptedImage(file: File): boolean {
  return ALLOWED_IMAGE_TYPES.includes(file.type.split(";")[0].toLowerCase());
}

/**
 * PDF か。申告（`File.type`）が空のときは拡張子で見る——OS に登録が
 * 無いと PDF でも型が空で届き、申告だけを見ると「添付できない形式」と
 * 弾かれる。サーバーも同じ補い方をし、中身（`%PDF-`）で確かめる。
 */
export function isPdfFile(file: File): boolean {
  const mime = file.type.split(";")[0].trim().toLowerCase();
  if (mime === PDF_TYPE) return true;
  return (
    (mime === "" || mime === "application/octet-stream") &&
    file.name.toLowerCase().endsWith(".pdf")
  );
}

/** 添付（R2 に置く）として受け取るファイルか。 */
export function isAcceptedAttachment(file: File): boolean {
  return isAcceptedImage(file) || isPdfFile(file);
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読み込めませんでした"));
    };
    img.src = url;
  });
}

function toBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * 必要なら縮小・再エンコードした File を返す。
 * 失敗した場合や効果がない場合は元のファイルをそのまま返す（送信を妨げない）。
 * アニメーションGIFは1コマ目に潰れてしまうため触らない。
 */
export async function prepareImage(file: File): Promise<File> {
  if (file.type === "image/gif") return file;

  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    return file;
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  if (scale === 1 && file.size <= REENCODE_THRESHOLD_BYTES) return file;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // WebPは透過を保てて圧縮率も高い。非対応環境ではJPEGへ退避する
  const blob =
    (await toBlob(canvas, "image/webp", 0.85)) ??
    (await toBlob(canvas, "image/jpeg", 0.85));
  if (!blob || blob.size >= file.size) return file;

  const ext = blob.type === "image/webp" ? "webp" : "jpg";
  const base = file.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${base}.${ext}`, { type: blob.type });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
