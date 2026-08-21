/**
 * 画像ファイルの先頭バイトから、本当の形式を読む。
 *
 * アップロードの検査は、これまでブラウザが申告する MIME（`File.type`）
 * だけを見ていた。申告はいくらでも詐称できるので、**中身が画像でない
 * ものを画像として保存し、画像として配信する**経路が開いていた。
 *
 * 先頭の数バイト（マジックナンバー）は形式ごとに決まっているので、
 * 申告と照らし合わせれば「言っているものと違う」ことは分かる。
 * 中身が正しい画像であることまでは保証しない——ここで防ぎたいのは
 * 「画像のふりをした別のもの」であって、壊れた画像ではない。
 */

/** 先頭バイトから見分けられる形式。constants.ts の許可リストと対応する。 */
export type ImageFormat = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function startsWith(bytes: Uint8Array, sig: number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  return sig.every((b, i) => bytes[at + i] === b);
}

/** 中身から形式を読む。見分けが付かなければ null。 */
export function sniffImageFormat(buffer: ArrayBuffer): ImageFormat | null {
  const b = new Uint8Array(buffer);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // GIF: "GIF87a" / "GIF89a"
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // WebP: "RIFF" ... "WEBP"（4〜7バイト目は長さなので飛ばす）
  if (
    startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * 申告された形式と中身が合っているか。
 *
 * JPEG は image/jpeg と image/jpg の両方で申告されうるので、
 * どちらも同じものとして扱う。
 */
export function matchesDeclared(
  buffer: ArrayBuffer,
  declared: string,
): boolean {
  const actual = sniffImageFormat(buffer);
  if (!actual) return false;
  const normalized = declared === "image/jpg" ? "image/jpeg" : declared;
  return actual === normalized;
}
