import {
  THUMBNAIL_LONG_SIDE_MAX,
  THUMBNAIL_QUALITY,
  THUMBNAIL_SHORT_SIDE,
} from "./constants";

/**
 * 生成画像の縮小版（一覧のサムネイル）をブラウザで作って R2 へ置く。
 *
 * 原寸を表示した端末は、その画像をデコード済みで持っている。そこから
 * canvas で縮小して送れば、Workers（無料プランの CPU 上限 10ms）で
 * リサイズせずに済む。以後どの端末の一覧も縮小版を読む。
 *
 * 縮小は 2 倍ずつ段階を踏む。一度に 1/4 以下へ縮めると、ブラウザの
 * 補間が飛ばす画素が増えてざらつく（細い線が途切れる）。
 */

/** 縮小後の大きさ。短い辺を 512px に（元がそれより小さければそのまま）。 */
export function thumbnailSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (short <= 0 || long <= 0) return { width, height };
  let scale = Math.min(1, THUMBNAIL_SHORT_SIDE / short);
  // 横長・縦長の画像で長い辺が無駄に大きくならないよう切る
  scale = Math.min(scale, THUMBNAIL_LONG_SIDE_MAX / long);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * 段階縮小の途中の幅。半分ずつ縮め、最後の1段が 1/2 以上の縮小率に
 * なるところで止める（最後に目的の大きさへ描く）。
 */
export function halvingSteps(from: number, to: number): number[] {
  const steps: number[] = [];
  let w = from;
  while (w / 2 > to) {
    w = Math.floor(w / 2);
    steps.push(w);
  }
  return steps;
}

/** 表示済みの img から縮小版を作る。canvas が使えなければ null。 */
export async function renderThumbnail(
  img: HTMLImageElement,
): Promise<Blob | null> {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w === 0 || h === 0) return null;
  const target = thumbnailSize(w, h);
  if (target.width >= w && target.height >= h && w * h < 400 * 400) {
    // 元が小さい。縮小の意味が無い
    return null;
  }

  let source: CanvasImageSource = img;
  let sw = w;
  let sh = h;
  for (const stepW of halvingSteps(w, target.width)) {
    const stepH = Math.round((h * stepW) / w);
    const c = document.createElement("canvas");
    c.width = stepW;
    c.height = stepH;
    const g = c.getContext("2d");
    if (!g) return null;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(source, 0, 0, sw, sh, 0, 0, stepW, stepH);
    source = c;
    sw = stepW;
    sh = stepH;
  }
  const out = document.createElement("canvas");
  out.width = target.width;
  out.height = target.height;
  const g = out.getContext("2d");
  if (!g) return null;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, sw, sh, 0, 0, target.width, target.height);

  /*
   * WebP を試し、出せなければ JPEG。Safari は出せない形式を頼まれると
   * 黙って PNG を返すので、返ってきた type で見分ける（PNG は縮小版
   * としては大きすぎる）。
   */
  const webp = await toBlob(out, "image/webp");
  if (webp && webp.type === "image/webp") return webp;
  const jpeg = await toBlob(out, "image/jpeg");
  if (jpeg && jpeg.type === "image/jpeg") return jpeg;
  return null;
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, THUMBNAIL_QUALITY);
    } catch {
      resolve(null);
    }
  });
}

/** 一度でも送った（送っている最中の）添付。同じ画面で何度も作らない。 */
const attempted = new Set<string>();

/**
 * 縮小版が無い添付について、表示済みの img から作って置く。
 *
 * 失敗は黙って飲む（一覧は原寸で見えているので、縮小版が無くても
 * 壊れてはいない。次に表示したときにまた試す）。
 */
export async function ensureThumbnail(
  id: string,
  img: HTMLImageElement,
): Promise<void> {
  if (attempted.has(id)) return;
  attempted.add(id);
  try {
    const blob = await renderThumbnail(img);
    if (!blob) return;
    const res = await fetch(`/api/files/${encodeURIComponent(id)}/thumb`, {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob,
    });
    if (!res.ok) attempted.delete(id);
  } catch {
    attempted.delete(id);
  }
}
