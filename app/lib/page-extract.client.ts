/**
 * 取ってきたページから、モデルに渡す本文を作る。
 *
 * **ブラウザにやらせる。** Workers の無料プランは1回の呼び出しで CPU を
 * 10ms しか使えず、数百KBのHTMLを解析するとそこに収まらない（同じ理由で
 * 画像の縮小もブラウザ側。`lib/constants.ts`）。ブラウザには本物の
 * HTML 解析器（DOMParser）があるので、正規表現でタグを剥がすより
 * 結果も良い——閉じ忘れや属性の中の `>` で崩れない。
 *
 * DOMParser の文書は**表示されない**（ブラウジングコンテキストを持たない）
 * ので、スクリプトは走らず、`<img>` も読みに行かない。取ってきた先の
 * サイトに「開いた」ことは伝わらない。
 *
 * 出すのはマークダウン寄りの文章。HTML をそのまま渡さないのは、タグと
 * 属性でトークンの大半が埋まるため（記事1本のHTMLは本文の10倍を超える
 * ことがある）。見出し・箇条書き・表・リンクは、モデルが読む上で意味を
 * 持つので形を残す。
 */

import type { PageResponse } from "./api-types";
import { TRUNCATED_MARK } from "./page-limits";

export { TRUNCATED_MARK };

export interface ExtractedPage {
  /** 見出し（空のこともある）。 */
  title: string;
  /** モデルへ渡す本文。 */
  text: string;
  /** 上限で切ったか。 */
  truncated: boolean;
}

/** 中身を読まない、または本文ではない要素。 */
const DROP_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "nav",
  "aside",
  "form",
  "[aria-hidden='true']",
  "[hidden]",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='search']",
].join(",");

/** 段落の切れ目を作る要素。 */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "details",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "header",
  "main",
  "ol",
  "p",
  "section",
  "summary",
  "ul",
]);

/** 本文の在り処として先に当たる場所。 */
const MAIN_SELECTOR = "main, article, [role='main']";

/**
 * `<main>` があっても、中身が薄ければ本文とは限らない。
 *
 * 記事以外の飾りに `<main>` を付けているページがあるので、取り出した
 * 量で見比べる。ここを見ずに `<main>` を信じると、本文がまるごと
 * 落ちたページを「取り込めた」として渡すことになる。
 */
const MAIN_MIN_CHARS = 200;

function isHtml(contentType: string): boolean {
  return (
    contentType === "text/html" ||
    contentType === "application/xhtml+xml" ||
    contentType === "text/xml" ||
    contentType === "application/xml"
  );
}

/** 出力を組み立てる先。行頭の空白と段落の切れ目だけを見張る。 */
function makeSink() {
  const parts: string[] = [];
  // 先頭は行頭とみなす（頭に空白を作らない）
  let last = "\n";
  const put = (s: string) => {
    if (s === "") return;
    parts.push(s);
    last = s[s.length - 1];
  };
  return {
    /** 地の文（行頭の空白は落とす）。 */
    text(s: string) {
      put(last === "\n" ? s.replace(/^ +/, "") : s);
    },
    /** そのまま入れる（コードブロックなど、字下げを保つもの）。 */
    raw(s: string) {
      put(s);
    },
    /** 段落の切れ目。重なったぶんは最後に畳む。 */
    block() {
      if (parts.length > 0) put("\n\n");
    },
    value: () => parts.join(""),
  };
}

type Sink = ReturnType<typeof makeSink>;

/** 相対リンクを絶対にする（読めなければ元のまま）。 */
function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** 行内の文字（表の枡やリンクの見出しに使う）。 */
function inlineText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 表をマークダウンの表にする。
 *
 * 枡を `textContent` で潰すので、表の中の入れ子は形を失う。行と列の
 * 対応のほうが読む上で効くので、そちらを採る。
 */
function renderTable(table: Element, out: Sink): void {
  const rows = [...table.querySelectorAll("tr")];
  if (rows.length === 0) return;
  out.block();
  rows.forEach((row, i) => {
    const cells = [...row.children].filter(
      (c) => c.tagName === "TD" || c.tagName === "TH",
    );
    if (cells.length === 0) return;
    // 枡の中の `|` は表の区切りに化けるので逃がす
    const texts = cells.map((c) => inlineText(c).replace(/\|/g, "\\|"));
    out.raw(`| ${texts.join(" | ")} |\n`);
    if (i === 0) out.raw(`| ${texts.map(() => "---").join(" | ")} |\n`);
  });
  out.block();
}

/** 子を順に見て回る。 */
function walk(node: Node, out: Sink, base: string): void {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3 /* テキスト */) {
      out.text((child.nodeValue ?? "").replace(/\s+/g, " "));
      continue;
    }
    if (child.nodeType !== 1 /* 要素 */) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === "br") {
      out.raw("\n");
      continue;
    }
    if (tag === "hr") {
      out.block();
      out.raw("---");
      out.block();
      continue;
    }
    if (/^h[1-6]$/.test(tag)) {
      const text = inlineText(el);
      if (text === "") continue;
      out.block();
      out.raw(`${"#".repeat(Number(tag[1]))} ${text}`);
      out.block();
      continue;
    }
    if (tag === "pre") {
      const code = (el.textContent ?? "").replace(/\n+$/, "");
      if (code.trim() === "") continue;
      out.block();
      out.raw("```\n");
      out.raw(code);
      out.raw("\n```");
      out.block();
      continue;
    }
    if (tag === "code") {
      const text = inlineText(el);
      if (text !== "") out.raw(`\`${text}\``);
      continue;
    }
    if (tag === "table") {
      renderTable(el, out);
      continue;
    }
    if (tag === "li") {
      out.block();
      const ordered = el.parentElement?.tagName === "OL";
      const index = [...(el.parentElement?.children ?? [])].indexOf(el) + 1;
      out.raw(ordered ? `${index}. ` : "- ");
      walk(el, out, base);
      out.block();
      continue;
    }
    if (tag === "a") {
      const text = inlineText(el);
      const href = el.getAttribute("href") ?? "";
      // 行き先の無いリンク（`#` だけ・javascript:）は文字として扱う
      if (text === "" || href === "" || /^(#|javascript:)/i.test(href)) {
        walk(el, out, base);
        continue;
      }
      out.text(`[${text}](${absolute(href, base)})`);
      continue;
    }
    if (tag === "img") {
      const alt = (el.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
      // 説明の無い画像は飾り。出しても本文の邪魔にしかならない
      if (alt === "") continue;
      /*
       * 画像記法（`![…](URL)`）にはしない。本文は自分の発言として
       * 画面にも出るが、外部の画像は CSP で止めてある（`lib/csp.ts`。
       * 画像を取りに行かせる経路は、会話の中身を外へ出す口になる）
       * ので、記法で書くと**必ず壊れた画像として並ぶ**。取りに行けない
       * URL を渡してもモデルの助けにはならないので、説明だけを残す。
       */
      out.text(`（画像: ${alt}）`);
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      out.block();
      walk(el, out, base);
      out.block();
      continue;
    }
    walk(el, out, base);
  }
}

/** 空行の重なりと行末の空白を畳む。 */
function tidy(text: string): string {
  return text
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 上限で切る（切ったことを本文に書く）。 */
function cap(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n${TRUNCATED_MARK}`,
    truncated: true,
  };
}

/** 見出しを拾う（og:title → `<title>` → 最初の見出し）。 */
function titleOf(doc: Document): string {
  const og = doc
    .querySelector("meta[property='og:title'], meta[name='og:title']")
    ?.getAttribute("content");
  const candidates = [og, doc.title, doc.querySelector("h1")?.textContent];
  for (const c of candidates) {
    const text = (c ?? "").replace(/\s+/g, " ").trim();
    if (text !== "") return text;
  }
  return "";
}

/**
 * 本文の在り処を決める。`<main>` や `<article>` があればそこ、
 * 薄ければ `<body>` 全体（MAIN_MIN_CHARS の項）。
 */
function rootOf(doc: Document): Element {
  const body = doc.body ?? doc.documentElement;
  let best: Element | null = null;
  for (const el of doc.querySelectorAll(MAIN_SELECTOR)) {
    const length = (el.textContent ?? "").trim().length;
    if (length > (best ? (best.textContent ?? "").trim().length : 0)) best = el;
  }
  if (!best) return body;
  const mainLength = (best.textContent ?? "").trim().length;
  if (mainLength < MAIN_MIN_CHARS) return body;
  return best;
}

/**
 * ページ1本ぶんを、モデルに渡せる文章にする。
 *
 * HTML でないもの（プレーンテキスト・JSON・CSV）はそのまま通す。
 * 形を変えずに渡したほうが読めるし、変えようが無い。
 */
export function extractPage(
  page: { url: string; contentType: string; body: string },
  /** 何文字までモデルへ渡すか（設定の `pageMaxChars`）。 */
  maxChars: number,
): ExtractedPage {
  if (!isHtml(page.contentType)) {
    const { text, truncated } = cap(
      page.body.replace(/\r\n/g, "\n").trim(),
      maxChars,
    );
    return { title: "", text, truncated };
  }

  const doc = new DOMParser().parseFromString(page.body, "text/html");
  const title = titleOf(doc);
  for (const el of doc.querySelectorAll(DROP_SELECTOR)) el.remove();
  const out = makeSink();
  walk(rootOf(doc), out, page.url);
  const { text, truncated } = cap(tidy(out.value()), maxChars);
  return { title, text, truncated };
}

/** 取り込んだページ1本ぶん（読んだ先のURLを添える）。 */
export interface LoadedPage extends ExtractedPage {
  /** 転送を追い終わった先。 */
  url: string;
}

/**
 * リンク1本を取り込む（サーバーに取ってきてもらい、ここで本文にする）。
 *
 * 取ってくるのをサーバーに任せるのは、ブラウザからは他所のサイトを
 * 読めない（CORS）ため。本文の取り出しだけがこちら側にある。
 *
 * 失敗は例外で返す。呼ぶ側はその文言を札に出し、送るときはリンクだけを
 * 渡す形に落とす。
 */
export async function loadPage(
  url: string,
  /** 何文字までモデルへ渡すか（設定の `pageMaxChars`）。 */
  maxChars: number,
): Promise<LoadedPage> {
  const res = await fetch("/api/page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const body = (await res.json().catch(() => null)) as
    | (Partial<PageResponse> & { error?: string })
    | null;
  if (!res.ok || typeof body?.body !== "string") {
    throw new Error(body?.error ?? `ページを取得できませんでした (${res.status})`);
  }
  const page = extractPage(
    {
      url: body.url ?? url,
      contentType: body.contentType ?? "text/html",
      body: body.body,
    },
    maxChars,
  );
  if (page.text.trim() === "") {
    // 中身の無い囲みを渡すと、モデルは「読んだが何も書いていない」と
    // 受け取る。読めなかったことは読めなかったこととして扱う
    throw new Error(
      "本文を取り出せませんでした（このページは JavaScript で本文を組み立てているのかもしれません）",
    );
  }
  return { ...page, url: body.url ?? url };
}
