/**
 * PDF を読めないモデルへの、OpenRouter 側の読み取りの選び方と見積もり。
 *
 * OpenRouter は、PDF をそのまま読めないモデルへは中で文字に起こしてから
 * 渡す。起こし方は2つで、こちらから指定する（指定しないと有料の OCR に
 * 落ちる——generation.server の pdfParserOf）。
 *
 * - 無料の文字起こし（Workers AI で Markdown にする）。スキャンした頁の
 *   文字や、図の中の文字は拾えない。
 * - 有料の OCR（1,000頁あたり $2）。スキャンや図の中の文字も読む。
 *
 * 選ぶのは利用者で、入力欄の知らせから切り替える（会話ごとに端末へ
 * 控える）。サーバーにもクライアントにも要るので、ここに置く。
 */

/** 無料の文字起こし。 */
export const PDF_PARSER_FREE = "cloudflare-ai";
/** 有料の OCR。 */
export const PDF_PARSER_OCR = "mistral-ocr";

/**
 * OCR の単価（1頁あたりのドル）。OpenRouter の文書の「1,000頁あたり $2」。
 * 米国の地域に固定した依頼は $2.2 だが、このアプリは地域を固定しない。
 */
export const OCR_USD_PER_PAGE = 2 / 1000;

export interface OcrEstimate {
  /** 頁数が分かった PDF の頁の合計。 */
  pages: number;
  /** 頁数が分からなかった PDF の数（見積もりに入っていない）。 */
  unknown: number;
  /** 分かったぶんの額（ドル）。 */
  usd: number;
}

/**
 * 1回送るぶんの OCR の額。
 *
 * **送るたびに**かかる。履歴の PDF は毎ターン送り直し、そのたびに
 * 読み直される（前の読み取りを使い回す仕組みはあるが、送り返し方が
 * 文書に無く、確かめられないので使っていない）。
 */
export function estimateOcr(pdfs: { pages?: number | null }[]): OcrEstimate {
  let pages = 0;
  let unknown = 0;
  for (const p of pdfs) {
    if (p.pages != null && p.pages > 0) pages += p.pages;
    else unknown++;
  }
  return { pages, unknown, usd: pages * OCR_USD_PER_PAGE };
}
