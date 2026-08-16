/**
 * チャットボットの応答に混ざるLaTeX記法を、remark-math が解釈できる形へ正規化する。
 *
 * モデルは数式を `\[ ... \]` `\( ... \)` `\begin{align} ... \end{align}` など
 * TeX由来の区切りで返してくることが多い。remark-math が見るのは `$` 区切りだけ
 * なので、そのままだと数式が生テキストとして表示されるうえ、
 *
 *   \[
 *   \boxed{ \text{国民の純利益}
 *   =
 *   \text{移民が生産した付加価値}
 *
 * のように `=` や `-` だけの行があると、マークダウン側がそれを setext 見出しの
 * 下線と解釈して、直前の行が巨大な見出しになってしまう（実際に起きていた不具合）。
 * パーサに渡す前にここで `$` 区切りへ寄せることで、どちらも起きなくなる。
 *
 * 変換はコードブロック・インラインコードの外側にだけ適用する。
 */

/** `\begin{...}` が数式の外に素で書かれていても数式として扱う環境。 */
const MATH_ENVIRONMENTS = new Set([
  "align",
  "aligned",
  "alignat",
  "array",
  "Bmatrix",
  "bmatrix",
  "cases",
  "darray",
  "dcases",
  "eqnarray",
  "equation",
  "flalign",
  "gather",
  "gathered",
  "matrix",
  "multline",
  "pmatrix",
  "smallmatrix",
  "split",
  "subarray",
  "Vmatrix",
  "vmatrix",
]);

type Chunk = { code: boolean; text: string };

/** ```/~~~ のフェンスで囲まれた部分と、それ以外に行単位で切り分ける。 */
function splitFencedCode(src: string): Chunk[] {
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let fence: string | null = null;

  for (const line of src.split("\n")) {
    if (fence) {
      buf.push(line);
      const close = new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}\\s*$`);
      if (close.test(line)) {
        chunks.push({ code: true, text: buf.join("\n") });
        buf = [];
        fence = null;
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (buf.length) chunks.push({ code: false, text: buf.join("\n") });
      buf = [line];
      fence = open[1];
      continue;
    }
    buf.push(line);
  }
  // 閉じていないフェンス（ストリーミング中）は、そのままコード扱いで残す
  if (buf.length) chunks.push({ code: fence != null, text: buf.join("\n") });
  return chunks;
}

/** `` `...` `` のインラインコードと、それ以外に切り分ける。 */
function splitInlineCode(src: string): Chunk[] {
  const chunks: Chunk[] = [];
  // 空行をまたぐバッククォートはコードスパンにならない
  const re = /(`+)((?:[^\n]|\n(?![ \t]*\n))*?)\1(?!`)/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) chunks.push({ code: false, text: src.slice(last, m.index) });
    chunks.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < src.length) chunks.push({ code: false, text: src.slice(last) });
  return chunks;
}

function findClose(text: string, from: number, re: RegExp) {
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** インライン数式として出力する。`$$...$$` は行中でもインライン数式になる。 */
function inlineMath(content: string): string {
  const body = content
    .replace(/\s*\n\s*/g, " ")
    .replace(/\\?\$/g, () => "\\$")
    .trim();
  return body ? `$$${body}$$` : "";
}

/**
 * ブロック数式として出力する。ただし文の途中に置かれていた場合は、
 * 段落を割らないようインライン数式にする。
 */
function displayMath(before: string, content: string, after: string): string {
  const body = content.replace(/^\s*\n/, "").replace(/\s+$/, "");
  if (!body.trim()) return "";
  const ownLine = /(^|\n)[ \t]*$/.test(before) && /^[ \t]*(\n|$)/.test(after);
  return ownLine ? `\n$$\n${body}\n$$\n` : inlineMath(body);
}

/**
 * `$x$` を数式として扱ってよさそうか。
 *
 * 「$100 から $200」のような通貨表記を数式にしてしまわないよう、
 * 区切りの内側が空白で始まらない/終わらないこと、英字か TeX らしい記号を
 * 含むことを条件にする（日本語まじりの金額表記はこれで弾ける）。
 */
function looksLikeMath(body: string): boolean {
  if (!body || /^\s|\s$/.test(body)) return false;
  return /[A-Za-z\\^_{}]/.test(body);
}

function convertMath(text: string): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\") {
      // `\(` `\[` が `\\(` `\\[` と二重にエスケープされて届くこともある
      const open = /^\\{1,2}(?:(\[)|(\()|begin\{([A-Za-z]+)(\*?)\})/.exec(
        text.slice(i, i + 32),
      );
      const from = open ? i + open[0].length : i;

      if (open?.[1]) {
        const close = findClose(text, from, /\\{1,2}\]/g);
        const end = close ? close.end : text.length;
        // 閉じていない場合（ストリーミング中）も数式として扱う。
        // 生のまま出すと `=` の行が見出しに化けて派手に崩れるため。
        out += displayMath(out, text.slice(from, close ? close.start : end), text.slice(end));
        i = end;
        continue;
      }

      if (open?.[2]) {
        const close = findClose(text, from, /\\{1,2}\)/g);
        if (close) {
          out += inlineMath(text.slice(from, close.start));
          i = close.end;
          continue;
        }
      }

      if (open?.[3] && MATH_ENVIRONMENTS.has(open[3])) {
        const env = `${open[3]}${open[4] ? "\\*" : ""}`;
        const close = findClose(text, from, new RegExp(`\\\\{1,2}end\\{${env}\\}`, "g"));
        const end = close ? close.end : text.length;
        out += displayMath(out, text.slice(i, end), text.slice(end));
        i = end;
        continue;
      }

      // それ以外のバックスラッシュはエスケープごとそのまま通す（`\$` など）
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === "$") {
      if (text[i + 1] === "$") {
        // すでに `$$ ... $$` になっているものは触らない
        const close = findClose(text, i + 2, /\$\$/g);
        const end = close ? close.end : text.length;
        out += text.slice(i, end);
        i = end;
        continue;
      }
      const single = /^\$([^$\n]+)\$/.exec(text.slice(i));
      if (single && looksLikeMath(single[1])) {
        out += inlineMath(single[1]);
        i += single[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/** LaTeXの区切り記号を `$` 区切りへ正規化する。 */
export function normalizeMath(src: string): string {
  if (!src.includes("\\") && !src.includes("$")) return src;
  return splitFencedCode(src)
    .map((chunk) =>
      chunk.code
        ? chunk.text
        : splitInlineCode(chunk.text)
            .map((part) => (part.code ? part.text : convertMath(part.text)))
            .join(""),
    )
    .join("\n");
}

/**
 * 画像として表示済みのURLが、本文にも裸で置かれている場合はそれを消す。
 *
 * Poeの画像生成ボットは `![...](url)` と、同じURLの行を続けて返すため、
 * そのままだと画像の下に長いリンクが重複して出る。保存内容には手を
 * 付けず、表示のときだけ落とす（URL単独の行に限るので、文中のリンクや
 * 別のURLは残る）。
 */
export function stripDuplicateImageUrls(markdown: string): string {
  const shown = new Set<string>();
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
    shown.add(m[1]);
  }
  if (shown.size === 0) return markdown;

  const kept = markdown.split("\n").filter((line) => {
    const text = line.trim();
    if (!text) return true;
    if (shown.has(text)) return false;
    // [url](url) や [表示名](url) の形で置かれることもある
    const link = /^\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)$/.exec(text);
    return !(link && shown.has(link[1]));
  });

  // 行を落とした跡の空行が続かないようにする
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** 表示直前の前処理をまとめて適用する。 */
export function prepareMarkdown(src: string): string {
  return normalizeMath(stripDuplicateImageUrls(src));
}
