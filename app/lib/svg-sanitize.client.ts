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

/** 参照してよい先。図の中の再利用と、埋め込み済みの画像だけ。 */
function safeRef(value: string): boolean {
  const url = value.trim();
  if (url.startsWith("#")) return true;
  return /^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(url);
}

/** CSS から外部を取りに行く書き方を落とす。 */
function scrubCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (whole, _q, url: string) =>
      safeRef(url) ? whole : "none",
    );
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
