/**
 * 画像の「形」の読み取り。
 *
 * 画像生成ボットのパラメータは名前も値もボット任せで、`aspect_ratio` に
 * "16:9"、`size` に "1536x1024" のような文字列がそのまま並ぶ。文字列の
 * ままだと、**どれが縦長でどれが横長かが読み取れない**——特に解像度の
 * 表記は、数字を2つ見比べて初めて分かる。ここで値を縦横の比へ読み替え、
 * UIが形そのものを描けるようにする。
 *
 * 値の書式はボット任せなので、決め打ちのキー名（aspect_ratio / size）では
 * なく「値が形として読めるか」で判定する。名前を増やしても追随しなくて済む。
 */

export interface Shape {
  /** 比の横。実寸ではなく比として扱う（1536x1024 も 3:2 も同じ形）。 */
  width: number;
  /** 比の縦。 */
  height: number;
  orientation: Orientation;
  /** 約分した比の表記（"1536x1024" → "3:2"）。約分できなければ元のまま。 */
  ratio: string;
}

export type Orientation = "square" | "landscape" | "portrait";

const ORIENTATION_LABELS: Record<Orientation, string> = {
  square: "正方形",
  landscape: "横長",
  portrait: "縦長",
};

export function orientationLabel(orientation: Orientation): string {
  return ORIENTATION_LABELS[orientation];
}

/**
 * 区切りは `:`（比）と `x` / `×` / `*`（解像度）。小数の比（"1.91:1"）も
 * 実在するため受ける。前後の空白は捨てる。
 */
const SHAPE = /^\s*(\d+(?:\.\d+)?)\s*[:x×*]\s*(\d+(?:\.\d+)?)\s*$/i;

function gcd(a: number, b: number): number {
  while (b > 0) [a, b] = [b, a % b];
  return a;
}

/** 整数どうしなら約分した比を返す。小数を含むならそのままの並びを返す。 */
function ratioText(width: number, height: number): string {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return `${width}:${height}`;
  }
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}

/**
 * 選択肢の値を形として読む。読めなければ null（"auto" など）。
 *
 * 0 は形にならない（描くと線1本になり、比としても意味が無い）ので弾く。
 */
export function parseShape(raw: unknown): Shape | null {
  if (typeof raw !== "string") return null;
  const m = SHAPE.exec(raw);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!(width > 0) || !(height > 0)) return null;
  return {
    width,
    height,
    orientation:
      width === height ? "square" : width > height ? "landscape" : "portrait",
    ratio: ratioText(width, height),
  };
}

/**
 * この選択肢の並びを「形を選ぶもの」として扱ってよいか。
 *
 * 1つだけでは判断材料にならない（たまたま形に見える値を持つ別のパラメータを
 * 巻き込む）ため、2つ以上が形として読めることを条件にする。"auto" のように
 * 混ざる非形の値は、選択肢としてはそのまま残す。
 */
export function isShapeChoice(values: readonly string[]): boolean {
  let seen = 0;
  for (const v of values) {
    if (parseShape(v) && ++seen >= 2) return true;
  }
  return false;
}

/**
 * 形の説明文（"3:2 横長"）。
 *
 * 比の表記（"16:9"）には向きだけを添える。既に2つの数の比として読める値を
 * 約分し直しても分かりやすくはならず、むしろ "21:9" の隣に "7:3" と出ると
 * 別の値に見える。解像度の表記にだけ、約分した比を足す。
 */
export function shapeHint(raw: string, shape: Shape): string {
  const orientation = orientationLabel(shape.orientation);
  return raw.includes(":") ? orientation : `${shape.ratio} ${orientation}`;
}
