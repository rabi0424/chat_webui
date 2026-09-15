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

import { ALLOWED_IMAGE_TYPES } from "./constants";
import { readImageSize, type ImageSize } from "./image-size";

export function isAcceptedImage(file: File): boolean {
  return ALLOWED_IMAGE_TYPES.includes(file.type.split(";")[0].toLowerCase());
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

/**
 * 送る実体そのものから縦横を読む。
 *
 * `Image` に読ませないのは、**縮小前の元ファイルではなく、実際に送る
 * ほうを測る**ため（`prepareImage` は長辺2048まで縮める）。読み取りは
 * サーバーと同じ関数を使うので、⚙に出る見積もりと、上流へ送られる
 * 大きさが同じ計算から出る。
 */
export async function blobImageSize(blob: Blob): Promise<ImageSize | null> {
  try {
    return readImageSize(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * URL で持っている画像の縦横（実体が手元に無い添付向け）。
 *
 * 生成画像を入力欄に載せたときと、送信前の控えから戻したときは、
 * バイト列がこちら側に無い。表示のために既に読み込んでいるので、
 * ブラウザの持っている大きさを借りる（取り直しは起きない）。
 */
export function urlImageSize(url: string): Promise<ImageSize | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () =>
      resolve(
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? { width: img.naturalWidth, height: img.naturalHeight }
          : null,
      );
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
