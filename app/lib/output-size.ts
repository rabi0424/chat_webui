/**
 * 出力画像の大きさの計算。サーバー/クライアント共用。
 *
 * 「入力画像の解像度を一定倍する」は、こちらが計算して上流へ渡す設定で、
 * 上流に同じ名前の項目があるわけではない。つまり**画面に出す見積もりと、
 * 実際に送る値が食い違いうる**——食い違っても画面にはエラーが出ず、
 * 出来上がった絵の大きさを数えて初めて気づくことになる。そうならない
 * よう、⚙の表示も送信も、この1本の関数から出す。
 *
 * 倍しただけの値はそのままでは送れない。上流には受け付ける形の決まりが
 * あり、外れると 400 で**その1本をまるごと失う**。
 *
 * - Runware: 縦横は16の倍数・総画素数 655,360〜8,294,400・縦横比は 3:1 まで。
 * - API易: 決まった選択肢のどれかだけ（文書に載っている値以外は送らない）。
 *
 * 大きすぎる側を黙って通さないのは、費用の話でもある。倍率は入力画像に
 * 掛かるので、4K を2倍すると33MPになる——⚙で数字を選んだときには
 * 「大きい絵」としか見えず、出来上がるまで額も時間も分からない。
 */

import type { ImageSize } from "./image-size";

export type { ImageSize };

/** 倍率の範囲。これを超える値は保存されていても丸める。 */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

/**
 * 上流の決まりに合わせるために動かした理由。画面に一言添えるために持つ
 * （黙って別の大きさで作られるのが、いちばん分かりにくい）。
 */
export type SizeAdjustment = "max" | "min" | "ratio" | "choice" | null;

export interface ResolvedSize {
  /** 上流へ送る値（"3072x2048" のような形）。 */
  value: string;
  size: ImageSize;
  adjustment: SizeAdjustment;
}

/** Runware が受け付ける形（上流の文書）。 */
export const RUNWARE_LIMITS = {
  /** 縦横はこの倍数でなければならない。 */
  step: 16,
  minPixels: 655360,
  maxPixels: 8294400,
  maxRatio: 3,
} as const;

export function pixelCount(size: ImageSize): number {
  return size.width * size.height;
}

/**
 * 画素数を MP で。小数第1位まで（0.4MP と 0.5MP を区別したい）。
 *
 * 小さすぎて 0.0MP になるもの（縮小した参考図・アイコン）は、0 と
 * 見分けが付かないので言葉にする。
 */
export function megapixelLabel(pixels: number): string {
  const mp = pixels / 1_000_000;
  if (mp > 0 && mp < 0.05) return "0.1MP未満";
  return `${mp.toFixed(1)}MP`;
}

/** 総画素数を MP で。 */
export function megapixelText(size: ImageSize): string {
  return megapixelLabel(pixelCount(size));
}

/** 画面に出す縦横。送信用の "x" ではなく、読みやすい "×" を使う。 */
export function sizeText(size: ImageSize): string {
  return `${size.width}×${size.height}`;
}

/** 上流へ送る形（"1536x1024"）。 */
export function sizeValue(size: ImageSize): string {
  return `${size.width}x${size.height}`;
}

/** "1536x1024" を読む。読めなければ null。 */
export function parseSizeValue(raw: unknown): ImageSize | null {
  const m = /^\s*(\d{1,5})\s*x\s*(\d{1,5})\s*$/i.exec(
    typeof raw === "string" ? raw : "",
  );
  if (!m) return null;
  const size = { width: Number(m[1]), height: Number(m[2]) };
  return size.width > 0 && size.height > 0 ? size : null;
}

/** 動かした理由の説明。画面にそのまま出す。 */
export function adjustmentText(adjustment: SizeAdjustment): string | null {
  switch (adjustment) {
    case "max":
      return `上限（${megapixelLabel(RUNWARE_LIMITS.maxPixels)}）に収めました`;
    case "min":
      return "下限に届くよう広げました";
    case "ratio":
      return "縦横比の上限（3:1）に収めました";
    case "choice":
      return "選べる大きさへ寄せました";
    default:
      return null;
  }
}

function scaled(input: ImageSize, scale: number): ImageSize {
  return { width: input.width * scale, height: input.height * scale };
}

/** 16 の倍数へ（下限は1段）。 */
function snap(n: number): number {
  const { step } = RUNWARE_LIMITS;
  return Math.max(step, Math.round(n / step) * step);
}

/**
 * Runware の決まりに収める。
 *
 * 先に実数のまま比と面積を当ててから16の倍数へ丸め、丸めで枠から出た
 * ぶんを最後に直す（下記4）。
 */
export function fitRunwareSize(target: ImageSize): ResolvedSize {
  const { step, minPixels, maxPixels, maxRatio } = RUNWARE_LIMITS;
  let adjustment: SizeAdjustment = null;
  let w = target.width;
  let h = target.height;

  // 1) 縦横比。長辺を短辺の3倍まで詰める
  if (w > h * maxRatio) {
    w = h * maxRatio;
    adjustment = "ratio";
  } else if (h > w * maxRatio) {
    h = w * maxRatio;
    adjustment = "ratio";
  }

  // 2) 面積。比を保ったまま枠の中へ
  const area = w * h;
  if (area > maxPixels) {
    const f = Math.sqrt(maxPixels / area);
    w *= f;
    h *= f;
    adjustment = "max";
  } else if (area < minPixels) {
    const f = Math.sqrt(minPixels / area);
    w *= f;
    h *= f;
    adjustment = "min";
  }

  // 3) 16 の倍数へ
  w = snap(w);
  h = snap(h);

  /*
   * 4) 丸めで枠から出たぶんを16ずつ直す。
   *
   * ここが要る。上限ちょうどに当てたあと16の倍数へ丸めると、**切り上げた
   * 1段ぶんだけ枠を超えた**値が残り、そのまま 400 になる。丸める向きを
   * 枠ごとに変える（上限なら切り捨て）手もあるが、それだとこの直しと
   * 二重になり、片方を消しても何も起きない状態になる。直しだけを置く。
   *
   * 詰めるのは長いほう・広げるのは短いほうと向きが決まっているので、
   * 3つの決まりが互いを壊し合わない（面積を減らす動きは比も良くする）。
   * 上限と下限は7.6M画素離れていて、1段（16px）では跨げない。
   */
  for (let i = 0; i < 64; i++) {
    if (w * h > maxPixels && w > step && h > step) {
      if (w >= h) w -= step;
      else h -= step;
      continue;
    }
    if (w > h * maxRatio && w > step) {
      w -= step;
      continue;
    }
    if (h > w * maxRatio && h > step) {
      h -= step;
      continue;
    }
    if (w * h < minPixels) {
      if (w <= h) w += step;
      else h += step;
      continue;
    }
    break;
  }

  const size = { width: w, height: h };
  return { value: sizeValue(size), size, adjustment };
}

/**
 * API易 の選択肢のうち、いちばん近いもの。
 *
 * この窓口は文書にある値しか受けないので、倍した大きさそのものは送れ
 * ない。**向きを最優先**で選ぶ——縦長の写真を倍したのに横長の枠で
 * 作られると、拡大ではなく作り直しになる。その中で総画素数が近いもの、
 * 並んだら小さいほう（大きい側へ倒すと、頼んでいない額がかかる）。
 */
export function nearestAllowedSize(
  target: ImageSize,
  allowed: readonly string[],
): ResolvedSize | null {
  const sizes = allowed
    .map((v) => ({ value: v, size: parseSizeValue(v) }))
    .filter((c): c is { value: string; size: ImageSize } => c.size != null);
  if (sizes.length === 0) return null;

  const orientation = (s: ImageSize) =>
    s.width === s.height ? "square" : s.width > s.height ? "landscape" : "portrait";
  const wanted = orientation(target);
  const sameShape = sizes.filter((c) => orientation(c.size) === wanted);
  const pool = sameShape.length > 0 ? sameShape : sizes;

  const want = pixelCount(target);
  let best = pool[0];
  let bestScore = Infinity;
  for (const c of pool) {
    // 比で測る（差で測ると、大きい側の1MPと小さい側の1MPが同じ重さに
    // なり、2倍と半分が同じ近さに見える）
    const score = Math.abs(Math.log(pixelCount(c.size) / want));
    if (score < bestScore || (score === bestScore && pixelCount(c.size) < pixelCount(best.size))) {
      best = c;
      bestScore = score;
    }
  }
  return { value: best.value, size: best.size, adjustment: "choice" };
}

/**
 * 入力画像を倍した大きさを、窓口の決まりに合わせて決める。
 *
 * 画面の見積もりも、実際に送る値もここを通る。
 */
export function scaledOutputSize(
  input: ImageSize,
  scale: number,
  target: { provider: "runware" } | { provider: "apiyi"; allowed: readonly string[] },
): ResolvedSize | null {
  if (!(input.width > 0) || !(input.height > 0)) return null;
  const clamped = Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
  if (!Number.isFinite(clamped)) return null;
  const wanted = scaled(input, clamped);
  if (target.provider === "runware") return fitRunwareSize(wanted);
  return nearestAllowedSize(wanted, target.allowed);
}
