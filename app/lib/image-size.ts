/**
 * 画像の縦横を、中身のバイト列から読む。
 *
 * 出力の大きさを「入力画像の何倍」で決める（`output-size.ts`）には、
 * 入力画像が実際に何ピクセルなのかが要る。**添付の行には縦横が無い**
 * （`attachments` は形式・名前・バイト数しか持たない）ので、実体から
 * 読むしかない。
 *
 * 描画に頼らないのは、**同じ答えをサーバーとブラウザの両方で出す**
 * ため。サーバー（Workers）には `Image` も canvas も無く、ブラウザ側で
 * `Image` に読ませた大きさを送ってもらう形にすると、送られてきた数字を
 * 信じて上流へ流すことになる。ここは1本の関数にして、画面の見積もりと
 * 実際に送る値を同じ計算から出す。
 *
 * 見るのはヘッダだけで、画素は展開しない（4K の1枚でも数十バイトしか
 * 読まない）。読めなければ null——**推測しない**。null のときは倍する
 * 設定を諦めて、選ばれている固定のサイズへ戻す（`output-size.ts`）。
 */

export interface ImageSize {
  width: number;
  height: number;
}

function be16(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}

/** PNG の大きさは符号なし32bit。`<<` は符号付きになるので掛け算で組む。 */
function be32(b: Uint8Array, at: number): number {
  return b[at] * 0x1000000 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
}

function le16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function le24(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
}

function has(b: Uint8Array, at: number, sig: number[]): boolean {
  if (b.length < at + sig.length) return false;
  return sig.every((v, i) => b[at + i] === v);
}

/** 4文字の識別子（PNG のチャンク名・RIFF の fourcc）を読む。 */
function fourcc(b: Uint8Array, at: number): string {
  if (b.length < at + 4) return "";
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG は先頭チャンクが必ず IHDR で、そこに縦横が入っている。 */
function pngSize(b: Uint8Array): ImageSize | null {
  if (!has(b, 0, PNG_SIGNATURE) || fourcc(b, 12) !== "IHDR") return null;
  if (b.length < 24) return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

/** GIF は先頭13バイトの中に論理画面の大きさが入っている（リトルエンディアン）。 */
function gifSize(b: Uint8Array): ImageSize | null {
  if (!has(b, 0, [0x47, 0x49, 0x46, 0x38]) || b.length < 10) return null;
  return { width: le16(b, 6), height: le16(b, 8) };
}

/**
 * 大きさを持つフレーム開始セグメント（SOF）。
 *
 * `0xC4`（ハフマン表）・`0xC8`（予約）・`0xCC`（算術符号の表）は
 * 同じ並びにいるが SOF ではない。ここを弾かずに読むと、表の中身を
 * 縦横として読んでしまう。
 */
function isSof(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

/**
 * JPEG は先頭に大きさが無い。SOF まで区間を飛ばしながら探す。
 *
 * 写真には EXIF（APP1）が付き、それだけで数十KBになることがある——
 * 「先頭の数百バイトを見れば分かる」とは限らないので、区間の長さを
 * 読んで正しく飛ばす。
 */
function jpegSize(b: Uint8Array): ImageSize | null {
  if (!has(b, 0, [0xff, 0xd8])) return null;
  let at = 2;
  while (at + 3 < b.length) {
    // 区間の頭は 0xFF。詰め物として 0xFF が続くことがあるので読み飛ばす
    if (b[at] !== 0xff) return null;
    let marker = b[at + 1];
    while (marker === 0xff && at + 2 < b.length) marker = b[++at + 1];
    at += 2;
    // 長さを持たない印（RSTn・SOI・EOI・TEM）はその場で次へ
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // 画像データに入った
    if (at + 1 >= b.length) return null;
    const length = be16(b, at);
    if (length < 2) return null;
    if (isSof(marker)) {
      // 長さ(2) 精度(1) 高さ(2) 幅(2)。**高さが先**
      if (at + 7 >= b.length) return null;
      return { width: be16(b, at + 5), height: be16(b, at + 3) };
    }
    at += length;
  }
  return null;
}

/**
 * WebP は中身が3通りある。
 *
 * `VP8 `（非可逆）・`VP8L`（可逆）・`VP8X`（透過やアニメを含む拡張）で
 * 大きさの置き場も詰め方も違う。ブラウザの canvas が吐くのは `VP8 ` か
 * `VP8L`、透過付きは `VP8X` になる——添付は縮小して WebP へ焼き直して
 * いるので、どれで来てもおかしくない。
 */
function webpSize(b: Uint8Array): ImageSize | null {
  if (!has(b, 0, [0x52, 0x49, 0x46, 0x46]) || fourcc(b, 8) !== "WEBP") {
    return null;
  }
  const kind = fourcc(b, 12);
  if (kind === "VP8 ") {
    // フレームタグ(3) のあと 0x9D 0x01 0x2A が来て、14bit の幅・高さが続く
    if (b.length < 30 || !has(b, 23, [0x9d, 0x01, 0x2a])) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (kind === "VP8L") {
    // 署名 0x2F のあと、14bit ずつの「幅-1」「高さ-1」が詰めて並ぶ
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (kind === "VP8X") {
    if (b.length < 30) return null;
    return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  }
  return null;
}

/**
 * 中身から縦横を読む。読めなければ null。
 *
 * 0 は大きさとして扱わない（倍率を掛けても 0 のままで、そのまま上流へ
 * 送ると「知らない大きさ」として1本まるごと失う）。
 */
export function readImageSize(buffer: ArrayBuffer): ImageSize | null {
  const b = new Uint8Array(buffer);
  const size =
    pngSize(b) ?? jpegSize(b) ?? gifSize(b) ?? webpSize(b) ?? null;
  if (!size) return null;
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
  if (size.width <= 0 || size.height <= 0) return null;
  return size;
}
