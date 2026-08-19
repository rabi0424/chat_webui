/**
 * モデルが描いた SVG を、暗い画面でも読める配色に置き換える。
 *
 * モデルの SVG は「白い紙に黒い線と文字」を前提に描かれていることが多く、
 * 暗い地の上にそのまま置くと読めない。かといって全部を反転すると、
 * データの色（棒グラフの色分け、赤=悪/緑=良、ヒートマップ）まで別物に
 * なってしまう。
 *
 * そこで、**彩度の低い色だけ**を入れ替える。
 *
 *  - 彩度がほぼ無い色 = 背景・文字・罫線。明度をひっくり返す
 *    （白い背景 → 暗い面、黒い文字 → 明るい文字）
 *  - 彩度のある色 = データそのもの。色相も鮮やかさも残し、暗い背景に対して
 *    contrast が足りないものだけ明るくする
 *
 * 明度と彩度は OKLab で測る。sRGB のまま数字をいじると、同じ「明度を半分」
 * でも色によって見え方の変わり方が違うため。
 *
 * 変換は消毒（svg-sanitize）の後に行う。ブラウザ専用。
 */

/** 暗いときの地の色（app.css のカード背景 neutral-900 に合わせる）。 */
const DARK_SURFACE = { r: 0x17, g: 0x17, b: 0x17 };

/**
 * ここまでを「無彩色（＝紙とインク）」とみなす OKLab の彩度。
 * 灰色は 0、少し青みがかった灰色でも 0.01 程度。steelblue は 0.08 ほどあり、
 * データの色として残る。
 */
const INK_CHROMA = 0.04;

/** データの色を持ち上げるときの上限（白飛びさせない）。 */
const MAX_L = 0.95;

/** 図形として見分けられる最低限の contrast（WCAG の非文字要素の基準）。 */
const MIN_CONTRAST = 3;

type Rgb = { r: number; g: number; b: number };

/** 色を持ちうる属性。 */
const COLOR_ATTRS = [
  "fill",
  "stroke",
  "stop-color",
  "flood-color",
  "lighting-color",
  "color",
];

/** CSS の中で色を持ちうる宣言。 */
const COLOR_PROPS =
  "fill|stroke|color|stop-color|flood-color|lighting-color|background|background-color|border|border-color|outline-color";

// --- 色の読み取り -----------------------------------------------------------

let canvas: CanvasRenderingContext2D | null | undefined;

/**
 * ブラウザ自身の色解釈を借りて、どんな書き方でも rgb に揃える。
 *
 * `steelblue` のような名前付きの色は 148 種あり、表を持つと重い。canvas に
 * 代入して読み返せば、名前でも `hsl()` でも `#abc` でも正規化された文字列で
 * 返ってくる。無効な値は代入が無視されるので、違う初期値で2回試して
 * 結果が一致するかで見分ける。
 */
function readColor(value: string): { rgb: Rgb; alpha: number } | null {
  if (canvas === undefined) {
    canvas = document.createElement("canvas").getContext("2d");
  }
  if (!canvas) return null;

  const text = value.trim();
  // 色ではないもの（塗りの参照・キーワード）は触らない
  if (!text || /^(none|currentcolor|inherit|initial|unset|url\()/i.test(text)) {
    return null;
  }

  canvas.fillStyle = "#000000";
  canvas.fillStyle = text;
  const first = String(canvas.fillStyle);
  canvas.fillStyle = "#ffffff";
  canvas.fillStyle = text;
  if (String(canvas.fillStyle) !== first) return null;

  const hex = /^#([0-9a-f]{6})$/i.exec(first);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: { r: n >> 16, g: (n >> 8) & 255, b: n & 255 }, alpha: 1 };
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(first);
  if (rgba) {
    const parts = rgba[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return {
        rgb: { r: parts[0], g: parts[1], b: parts[2] },
        alpha: Number.isFinite(parts[3]) ? parts[3] : 1,
      };
    }
  }
  return null;
}

function toCss({ rgb, alpha }: { rgb: Rgb; alpha: number }): string {
  const hex = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  const base = `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
  return alpha >= 1 ? base : `${base}${hex(alpha * 255)}`;
}

// --- OKLab ------------------------------------------------------------------

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const toSrgb = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

type Oklab = { L: number; a: number; b: number };

function toOklab({ r, g, b }: Rgb): Oklab {
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function fromOklab({ L, a, b }: Oklab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

const chromaOf = ({ a, b }: Oklab) => Math.hypot(a, b);

// --- contrast ---------------------------------------------------------------

function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

const SURFACE_LUMINANCE = luminance(DARK_SURFACE);

function contrast(rgb: Rgb): number {
  const a = luminance(rgb);
  const [hi, lo] =
    a > SURFACE_LUMINANCE ? [a, SURFACE_LUMINANCE] : [SURFACE_LUMINANCE, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 無彩色の置き換え先の明度。
 *
 * 明度をそのままひっくり返すと（`1 - L`）、中間の灰色が中間の灰色のまま
 * 残ってしまう。地は白から暗い面へ移っているので、それでは目立ち方が
 * 変わってしまう——薄墨で書いた控えめな軸ラベルが、暗い地の上でほとんど
 * 見えなくなる。
 *
 * そこで明度ではなく「紙に対する contrast」のほうを引き継ぐ。白い紙の上で
 * 2.5倍だった文字は、暗い地の上でも 2.5倍になる明るさに置く。真っ黒な文字は
 * 白く、紙そのもの（白）は地の色ちょうどに落ちる。
 */
function inkLightness(lab: Oklab, rgb: Rgb): number {
  // 元の紙は白い前提。そこに対する contrast を目標にする
  const wanted =
    ((1 + 0.05) / (luminance(rgb) + 0.05)) * (SURFACE_LUMINANCE + 0.05) - 0.05;
  const target = Math.max(0, Math.min(1, wanted));

  // 目標の輝度になる OKLab の明度を二分探索で求める（色味は変えない）
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (luminance(fromOklab({ ...lab, L: mid })) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// --- 置き換え ---------------------------------------------------------------

/** 1色を、暗い地の上で読める色に直す。変える必要がなければ元のまま返す。 */
function darken(value: string): string | null {
  const parsed = readColor(value);
  if (!parsed) return null;
  // 透明なものは触らない（見えないので直す意味がない）
  if (parsed.alpha === 0) return null;

  const lab = toOklab(parsed.rgb);

  if (chromaOf(lab) < INK_CHROMA) {
    // 紙とインク。白い紙に対する目立ち方を、暗い地の上で作り直す
    return toCss({
      rgb: fromOklab({ ...lab, L: inkLightness(lab, parsed.rgb) }),
      alpha: parsed.alpha,
    });
  }

  // データの色。色味は残したまま、暗すぎて沈むものだけ持ち上げる
  let lit = { ...lab };
  for (let i = 0; i < 20 && contrast(fromOklab(lit)) < MIN_CONTRAST; i++) {
    if (lit.L >= MAX_L) break;
    lit = { ...lit, L: Math.min(MAX_L, lit.L + 0.04) };
  }
  return lit.L === lab.L
    ? null
    : toCss({ rgb: fromOklab(lit), alpha: parsed.alpha });
}

/** CSS の宣言の中の色を置き換える（`style` 属性と `<style>` の両方で使う）。 */
function darkenCss(css: string): string {
  return css.replace(
    new RegExp(`(^|[;{\\s])(${COLOR_PROPS})(\\s*:\\s*)([^;}]+)`, "gi"),
    (whole, pre: string, prop: string, sep: string, rawValue: string) => {
      const important = /!important\s*$/i.exec(rawValue)?.[0] ?? "";
      const value = rawValue.slice(0, rawValue.length - important.length).trim();
      const next = darken(value);
      return next ? `${pre}${prop}${sep}${next}${important}` : whole;
    },
  );
}

/**
 * 消毒済みの SVG を、暗い画面向けの配色にして返す。
 *
 * 元の文字列は変えない（毎回ここから作り直せるので、テーマを往復しても
 * 色がずれていかない）。
 */
export function recolorForDark(svgHtml: string): string {
  const doc = new DOMParser().parseFromString(
    `<div>${svgHtml}</div>`,
    "text/html",
  );
  const root = doc.body.firstElementChild?.querySelector("svg");
  if (!root) return svgHtml;

  const walk = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    // 埋め込み画像は色を測れない（塗り分けではなく絵なので触らない）
    if (tag === "image") return;

    if (tag === "style" && el.textContent) {
      el.textContent = darkenCss(el.textContent);
    }

    for (const name of COLOR_ATTRS) {
      const value = el.getAttribute(name);
      if (value == null) continue;
      const next = darken(value);
      if (next) el.setAttribute(name, next);
    }

    const style = el.getAttribute("style");
    if (style) el.setAttribute("style", darkenCss(style));

    for (const child of el.children) walk(child);
  };

  walk(root);
  return root.outerHTML;
}
