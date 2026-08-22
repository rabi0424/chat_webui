/**
 * モデルが返した SVG を、画面に出しても安全な形に削る。
 *
 * SVG は「ただの画像」ではなく、スクリプトも外部読み込みも書ける文書形式。
 * 本文はモデルの出力なので、次の4つを潰してから描く。
 *
 *  1. スクリプトの実行 —— `<script>` `onload=` `href="javascript:"` など
 *  2. `<foreignObject>` —— 中に任意のHTMLを入れられる（SVGの消毒を素通りする
 *     典型的な抜け道）
 *  3. 外部への通信 —— `<image href="https://…">` `<use href="外部">`、CSSの
 *     `@import` や `url(https://…)`。開いただけで相手に接続してしまう
 *  4. アニメーションによる属性の書き換え —— `<animate attributeName="href">`
 *     のように、後から危険な属性を生やす手口
 *
 * なお `<use>` と `<symbol>` の中身は DOMPurify 自身が落とす（内部参照でも）。
 * アイコンを1か所に定義して使い回す書き方の図では、その部分が空になる。
 * 安全側に倒した結果なので、戻すなら参照先を `#` に限る仕掛けが要る。
 *
 * `<style>` は落とさずに残す。モデルの SVG はクラスで色を付けていることが
 * 多く、消すと図が崩れるため。ページ全体に漏れる問題のほうは、描画側
 * （SvgBlock）が shadow DOM に入れて閉じ込めることで防ぐ。
 *
 * DOM が要るのでブラウザ専用。`.client.ts` にしてサーバー側のビルドからは
 * 外している。
 */
import DOMPurify from "dompurify";

/** 中に何を入れられるか分からない、または実行系の要素。 */
const FORBIDDEN_TAGS = [
  "script",
  "foreignobject",
  "iframe",
  "embed",
  "object",
  "audio",
  "video",
  "link",
  "meta",
  "base",
  "handler",
  "listener",
  // 属性を後から書き換えられるので、図の見栄えより安全を採る
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
];

/**
 * 参照してよい先。図の中の再利用と、埋め込み済みの画像だけ。
 *
 * data: は画素の画像に限る。SVGを data: で埋め込むと、その中身は
 * ここの消毒を通らないまま参照されることになり、参照する側の要素
 * しだいでは中の記述が生きてしまう（歴史的に知られた抜け道）。
 * 図として必要になるのは画素の画像なので、SVGは許さない。
 */
function safeRef(value: string): boolean {
  const url = value.trim();
  if (url.startsWith("#")) return true;
  return /^data:image\/(png|jpeg|gif|webp);/i.test(url);
}

/**
 * url() のほかに、外部を取りに行ける書き方。
 *
 * url( が1度も出てこないので、url() だけを見ていると素通りする。
 * image-set は実際に Chromium が取りに行くことを確かめてある。
 */
const FETCHING_FUNCTIONS =
  /(^|[^\w-])(-webkit-image-set|image-set|-webkit-cross-fade|cross-fade|image)\s*\(/gi;

/** open の位置の "(" に対応する ")" を返す。見つからなければ -1。 */
function matchParen(css: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** image-set(...) のような呼び出しを、丸ごと none に置き換える。 */
function dropFetchingFunctions(css: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    FETCHING_FUNCTIONS.lastIndex = from;
    const m = FETCHING_FUNCTIONS.exec(css);
    if (!m) return out + css.slice(from);
    const nameAt = m.index + m[1].length;
    const close = matchParen(css, m.index + m[0].length - 1);
    out += css.slice(from, nameAt) + "none";
    if (close < 0) return out; // 閉じていない＝以降は捨てる
    from = close + 1;
  }
}

/** 外部を取りに行く書き方を落とす（1回ぶん）。 */
function scrubOnce(css: string): string {
  return dropFetchingFunctions(css)
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (whole, _q, url: string) =>
      safeRef(url) ? whole : "none",
    );
}

/**
 * CSS のエスケープを解く。**検出のためだけ**に使い、返り値は表示に使わない。
 *
 * content: "\201C" のような正当な書き方も一緒にほどけてしまうため、
 * ほどいた文字列をそのまま出すと図が壊れる。
 */
function decodeCssEscapes(css: string): string {
  return css.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|([^\r\n\f0-9a-fA-F]))/g,
    (whole, hex: string | undefined, ch: string | undefined) => {
      if (ch !== undefined) return ch;
      const cp = Number.parseInt(hex!, 16);
      // 0・サロゲート・範囲外は文字にならない。そのまま残す
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      return String.fromCodePoint(cp);
    },
  );
}

/**
 * CSS から外部を取りに行く書き方を落とす。
 *
 * 素直に書いた url() や image-set() は上の scrubOnce が落とす。**ただし
 * CSS は関数名そのものをエスケープで書ける**——`\75 rl(...)` はブラウザに
 * とって url(...) だが、文字列としては url( を含まない。正規表現をいくら
 * 足しても、書き手はもう一段エスケープすれば抜けられる。
 *
 * そこで、掃除したあとの CSS のエスケープを解き、もう一度同じ掃除を
 * かける。そこで初めて何かが落ちるなら、素の掃除は素通りされていた
 * ということなので、その CSS は丸ごと捨てる（図の見た目より安全を採る）。
 * 返すのは解く前のほうなので、正当なエスケープを含む図は壊れない。
 */
function scrubCss(css: string): string {
  const cleaned = scrubOnce(css);
  const decoded = decodeCssEscapes(cleaned);
  return scrubOnce(decoded) === decoded ? cleaned : "";
}

let hooked = false;

/**
 * DOMPurify の既定の SVG プロファイルは `href` を通してしまうので、
 * 参照先を自分で確かめる。フックは1回だけ登録する。
 */
function installHooks(): void {
  if (hooked) return;
  hooked = true;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;

    for (const name of ["href", "xlink:href", "src"]) {
      const value = el.getAttribute?.(name);
      if (value != null && !safeRef(value)) el.removeAttribute(name);
    }

    // style="background:url(...)" のような書き方からの通信も止める
    const style = el.getAttribute?.("style");
    if (style) el.setAttribute("style", scrubCss(style));

    // <style> の中身（クラス定義）はここでしか触れない
    if (el.tagName?.toLowerCase() === "style" && el.textContent) {
      el.textContent = scrubCss(el.textContent);
    }
  });
}

/**
 * 消毒した SVG を返す。SVG として読めなければ null。
 *
 * 返り値は「消毒済みだが、閉じ込めてから描くべきもの」。そのまま本文へ
 * 差し込まず、必ず shadow DOM 越しに置くこと（`<style>` を残しているため）。
 */
export function sanitizeSvg(source: string): string | null {
  installHooks();

  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    // イベント属性は DOMPurify が既定で落とすが、意図を残すため明示する
    FORBID_ATTR: ["onload", "onerror", "onclick", "onmouseover", "onbegin"],
    ALLOW_DATA_ATTR: false,
    // 断片として扱う（<html> でくるまれない）
    RETURN_DOM_FRAGMENT: false,
  });

  const doc = new DOMParser().parseFromString(
    `<div>${clean}</div>`,
    "text/html",
  );
  const svg = doc.body.firstElementChild?.querySelector("svg");
  if (!svg) return null;

  // 枠に収める。比率は viewBox に持たせ、寸法は CSS 側で決める
  const width = svg.getAttribute("width");
  const height = svg.getAttribute("height");
  const number = (v: string | null) =>
    v && /^[\d.]+(px)?$/.test(v) ? parseFloat(v) : null;

  if (!svg.getAttribute("viewBox")) {
    const w = number(width);
    const h = number(height);
    if (w && h) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }

  /**
   * 描かれたときの幅。作者が想定した大きさを上限にして、狭い画面でだけ
   * 縮める。枠いっぱいに引き伸ばすと、320px 前提で置かれた文字や線が
   * 拡大されて不格好になる（逆に大きすぎる図は枠に収まる）。
   */
  const boxWidth = parseFloat(
    svg.getAttribute("viewBox")?.split(/[\s,]+/)[2] ?? "",
  );
  const intrinsic =
    number(width) ?? (Number.isFinite(boxWidth) ? boxWidth : null);

  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute(
    "style",
    intrinsic
      ? `width:min(100%, ${Math.round(intrinsic)}px);height:auto;display:block`
      : "max-width:100%;height:auto;display:block",
  );

  return svg.outerHTML;
}

/**
 * そのコードブロックが SVG かどうか。
 *
 * ` ```xml ` は SVG 以外（設定ファイルなど）にも使われるので、中身が
 * 本当に `<svg` で始まるときだけ図にする。XML宣言・DOCTYPE・コメントが
 * 前に付いていることがあるので、そこは読み飛ばす。
 */
export function looksLikeSvg(source: string): boolean {
  let text = source.trimStart();
  for (;;) {
    if (text.startsWith("<?")) {
      const end = text.indexOf("?>");
      if (end < 0) return false;
      text = text.slice(end + 2).trimStart();
      continue;
    }
    if (text.startsWith("<!--")) {
      const end = text.indexOf("-->");
      if (end < 0) return false;
      text = text.slice(end + 3).trimStart();
      continue;
    }
    if (text.toLowerCase().startsWith("<!doctype")) {
      const end = text.indexOf(">");
      if (end < 0) return false;
      text = text.slice(end + 1).trimStart();
      continue;
    }
    break;
  }
  return /^<svg[\s>]/i.test(text);
}
