/**
 * 落とされた・選ばれたテキストファイルを、入力欄の札に変えるための下ごしらえ。
 *
 * 添付（R2 に置いてモデルへ渡す）にはしない。**添付の器は画像専用**で、
 * モデルへ組み立てるのも `image_url` だけ（`generation.server.ts`）。
 * OpenAI 互換の補完に「テキストファイル」という渡し方は無いので、
 * 添付として持っても送るときは本文へ流し込むことになる。それなら
 * 最初から本文の側——貼り付け・リンクと同じ札（`lib/paste.ts`）に
 * 乗せるほうが、全文が届くし、送る前に展開して直せる。
 *
 * つまり **`.txt` を落とすのは、その中身を貼り付けるのと同じこと**に
 * する。`.html` はリンクを取り込むときと同じ変換（`page-extract.client`）
 * を通す。
 */

/**
 * 中身をテキストとして読むファイルの拡張子。
 *
 * **MIME ではなく拡張子で見る。** ブラウザが `File.type` に入れる値は
 * OS の登録次第で、`.md` や `.py` は空になることが多い。さらに `.ts` は
 * 多くの環境で `video/mp2t`（MPEG transport stream）と申告される——
 * MIME を信じると、TypeScript のファイルが動画として弾かれる。
 */
const TEXT_EXTENSIONS = [
  // 文章・データ
  ".txt", ".text", ".log", ".md", ".markdown", ".rst",
  ".csv", ".tsv",
  ".json", ".jsonl", ".ndjson",
  ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".diff", ".patch", ".tex", ".srt", ".vtt",
  // 目印（HTML は本文の取り出しを通す。下の HTML_EXTENSIONS と揃える）
  ".html", ".htm", ".xhtml",
  // コード
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
  ".css", ".scss", ".sass", ".less",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".m",
  ".php", ".pl", ".lua", ".r",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat",
  ".sql", ".graphql", ".proto",
  ".vue", ".svelte", ".astro",
];

/** 本文の取り出し（DOMParser）を通す拡張子。 */
const HTML_EXTENSIONS = [".html", ".htm", ".xhtml"];

/**
 * 拡張子で拾えなかったものの受け皿。
 *
 * OS が「テキストだ」と言っているならそれに従う。上の一覧に無い
 * 拡張子（新しい言語・独自の拡張子）でも読めるようにするため。
 */
function looksTextual(type: string): boolean {
  const mime = type.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("text/")) return true;
  return ["application/json", "application/xml", "application/xhtml+xml"].includes(mime);
}

/** 小文字にした拡張子（`.` 込み。無ければ空文字）。 */
function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  if (at <= 0) return "";
  return name.slice(at).toLowerCase();
}

export function isTextFile(file: File): boolean {
  if (TEXT_EXTENSIONS.includes(extensionOf(file.name))) return true;
  // 一覧に無い拡張子・拡張子の無いファイルでも、OS がテキストだと
  // 言うなら読む（画像は `image/…` なので、ここには落ちてこない）
  return looksTextual(file.type);
}

/** 本文の取り出しに渡す Content-Type（`extractPage` がこれで分岐する）。 */
export function textFileContentType(name: string): string {
  return HTML_EXTENSIONS.includes(extensionOf(name)) ? "text/html" : "text/plain";
}

/** ファイル選択の `accept` に足す値（拡張子そのもの）。 */
export const TEXT_FILE_ACCEPT = TEXT_EXTENSIONS;

/**
 * バイト列を文字にする。
 *
 * **UTF-8 と決め打たない。** 手元の `.txt` や `.csv`（表計算から書き出した
 * もの）は Shift_JIS のことがあり、UTF-8 として読むと文字化けした本文が
 * そのままモデルへ渡る——モデルは化けた文字にも何か答えるので、
 * **読み違えたことに気づけないまま答えが返る**のがいちばん困る。
 *
 * そこで BOM → UTF-8（誤りを許さない）→ Shift_JIS の順に試す。
 * 誤りを許さない設定にするのが肝で、これが無いと UTF-8 の復号は
 * どんなバイト列でも `�` を並べて「成功」してしまい、Shift_JIS へ
 * 落ちる道が永久に選ばれない。
 */
export function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  for (const label of ["utf-8", "shift_jis"]) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch {
      // 次の符号化を試す
    }
  }
  // どれでも読めない。読める字だけでも渡す（`�` が出れば目で分かる）
  return new TextDecoder("utf-8").decode(bytes);
}

/** 読み取った1ファイル。 */
export interface ReadTextFile {
  name: string;
  /** `extractPage` に渡す種別。 */
  contentType: string;
  /** 中身。 */
  body: string;
  /** 大きさの上限で切ったか。 */
  truncated: boolean;
}

/**
 * ファイルを読む。`maxBytes` を超えるぶんは切る。
 *
 * 切るのを字数ではなくバイトで先にやるのは、数百MBのログを丸ごと
 * メモリへ載せないため（字数の上限は、このあと `extractPage` が見る）。
 */
export async function readTextFile(
  file: File,
  maxBytes: number,
): Promise<ReadTextFile> {
  const truncated = file.size > maxBytes;
  const part = truncated ? file.slice(0, maxBytes) : file;
  return {
    name: file.name,
    contentType: textFileContentType(file.name),
    body: decodeText(await part.arrayBuffer()),
    truncated,
  };
}
