/**
 * PDF の頁数を数える（端末で。OCR の見積もりに使う）。
 *
 * 見積もりのためだけに PDF の読み手（pdf.js、本体と worker で 1MB 超）を
 * 載せるのは割に合わないので、頁の木の根にある `/Count` を探す。
 * 根は `/Type /Pages` の辞書で、`/Count` が子孫の頁の総数を持つ。途中の
 * 節も同じ形をしているが、数は根より小さいので**いちばん大きいもの**を
 * 採る。
 *
 * 素直に `/Type /Pages` を文字として探すだけでは足りない。PDF 1.5 以降の
 * 書き出し（cairo・Office・Acrobat の多く）は、辞書を**圧縮した入れ物**
 * （`/Type /ObjStm`）の中に詰める。外からは `/Count` が1つも見えない
 * ——そのときだけ入れ物を開いて探す（`tests/pdf-pages.test.ts` の
 * cairo が書いた PDF がこの形）。
 *
 * 分からないときは null を返す（暗号化されている・壊れている・見たことの
 * ない形）。見積もりは「頁数が分からない」と出す。黙って 0 頁にすると、
 * 有料の OCR が無料に見える。
 *
 * 過大に出ることはある: 頁を消して上書き保存（追記の更新）した PDF は、
 * 消す前の根も中に残っていて、大きいほうを採るため。費用の見積もりと
 * しては、少なく見せるより安全な側に倒れる。
 */

/** 開いてみる入れ物の数の上限。数千の入れ物を持つ PDF で固まらないように。 */
const MAX_OBJECT_STREAMS = 200;

/** 辞書の端を探しに戻る距離（文字）。頁の木の辞書はこれよりずっと短い。 */
const DICT_SCAN = 4096;

export async function countPdfPages(buffer: ArrayBuffer): Promise<number | null> {
  const bytes = new Uint8Array(buffer);
  // 1バイト = 1文字で読む（位置がバイトの位置とずれないように）
  const text = new TextDecoder("latin1").decode(bytes);

  const plain = maxPagesCount(text) ?? linearizedPages(text);
  if (plain != null) return plain;

  let best: number | null = null;
  for (const body of objectStreams(bytes, text)) {
    const inflated = await inflate(body);
    if (inflated == null) continue;
    const n = maxPagesCount(inflated);
    if (n != null) best = Math.max(best ?? 0, n);
  }
  return best;
}

/** `/Type /Pages` の辞書の `/Count` のうち、いちばん大きいもの。 */
function maxPagesCount(text: string): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(/\/Type\s*\/Pages(?![A-Za-z0-9])/g)) {
    const dict = enclosingDict(text, m.index);
    if (!dict) continue;
    const count = /\/Count\s+(\d+)/.exec(dict);
    if (count) best = Math.max(best ?? 0, Number(count[1]));
  }
  return best;
}

/**
 * 頁の木が入れ物の中にあっても、「線形化」された PDF（ウェブ表示向けの
 * 書き出し）は先頭の辞書に頁数（`/N`）を素のまま持つ。開かずに済む。
 */
function linearizedPages(text: string): number | null {
  const m = /\/Linearized(?![A-Za-z0-9])/.exec(text);
  if (!m) return null;
  const dict = enclosingDict(text, m.index);
  const n = dict ? /\/N\s+(\d+)/.exec(dict) : null;
  return n ? Number(n[1]) : null;
}

/** at を含む `<< … >>` の中身。入れ子を数えて端を探す。 */
function enclosingDict(text: string, at: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = at; i > Math.max(0, at - DICT_SCAN); i--) {
    if (text.startsWith(">>", i - 1)) {
      depth++;
      i--;
    } else if (text.startsWith("<<", i - 1)) {
      if (depth === 0) {
        start = i + 1;
        break;
      }
      depth--;
      i--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < Math.min(text.length, start + DICT_SCAN); i++) {
    if (text.startsWith("<<", i)) {
      depth++;
      i++;
    } else if (text.startsWith(">>", i)) {
      if (depth === 0) return text.slice(start, i);
      depth--;
      i++;
    }
  }
  return null;
}

/** 圧縮された入れ物（`/Type /ObjStm`）の中身のバイト列。 */
function* objectStreams(bytes: Uint8Array, text: string): Generator<Uint8Array> {
  let seen = 0;
  for (const m of text.matchAll(/\/Type\s*\/ObjStm(?![A-Za-z0-9])/g)) {
    if (++seen > MAX_OBJECT_STREAMS) return;
    const dict = enclosingDict(text, m.index);
    // Flate かどうかは見ない。Flate でなければ開くのに失敗して飛ばすだけで、
    // 圧縮していない入れ物の中身は、最初の素の検索で既に見えている
    if (!dict) continue;
    // 辞書の直後の `stream` と改行のあとから本体が始まる
    const after = text.indexOf(dict, m.index - DICT_SCAN) + dict.length;
    const head = /\s*stream\r?\n/y;
    head.lastIndex = text.indexOf(">>", after) + 2;
    if (!head.exec(text)) continue;
    const begin = head.lastIndex;
    // 長さが数で書いてあればそれを使う。間接参照（`48 0 R`）なら
    // `endstream` まで取り、手前の改行を落とす。参照かどうかは後ろを
    // 一緒に読んで決める——「後ろに参照が続かない数」と否定で書くと、
    // `48 0 R` の `4` だけを長さとして拾う（cairo の PDF で起きた）
    const m2 = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dict);
    const len = m2 && !m2[2] ? m2 : null;
    let end = len ? begin + Number(len[1]) : text.indexOf("endstream", begin);
    if (end < begin) continue;
    if (!len) while (end > begin && /[\r\n]/.test(text[end - 1])) end--;
    yield bytes.subarray(begin, end);
  }
}

/** zlib の Flate を開く。開けなければ（暗号化・壊れている）null。 */
async function inflate(body: Uint8Array): Promise<string | null> {
  try {
    const stream = new Response(body as BodyInit).body!.pipeThrough(
      new DecompressionStream("deflate"),
    );
    const out = await new Response(stream).arrayBuffer();
    return new TextDecoder("latin1").decode(out);
  } catch {
    return null;
  }
}
