/**
 * 会話の本文が何語で書かれているかの、ごく粗い判定。
 *
 * Safari の翻訳は、読み込んだ文書の言語を見て「翻訳するかどうか」を決める。
 * この画面はサーバーが**器だけ**を返す作りなので（Error 1102 対策。§3.3）、
 * 読み込み時点で Safari が見られるのは `<html lang="ja">` の宣言だけになる
 * ——英語の会話を開いても「日本語のページ」と判定され、翻訳が出てこない。
 *
 * そこで本文が出そろった時点で宣言を実態に合わせる。判定はここで行う。
 *
 * **ライブラリは使わない。** 判定に必要なのは「日本語かそれ以外か」だけで、
 * そのために数百KBをバンドルへ持ち込むと、Workers の側で払うものが
 * 大きすぎる（文字種を数えれば足りる）。
 *
 * 見分けるのは日本語と英語の2つだけ。上流のモデルが返すのはほぼこの
 * どちらかで、それ以外の言語（仏語など）は英語として扱われる——宣言としては
 * 正しくないが、Safari 自身も内容から言語を推定するので、「日本語」と
 * 言い張るよりは翻訳に辿り着ける。
 */

/**
 * ひらがな・カタカナ（半角も含む）・漢字。
 *
 * 範囲を手で並べると、増えた面（拡張漢字。𠮟 のように BMP の外にある字）を
 * 取りこぼす。実際に取りこぼしていたので、Unicode の書記体系そのもので指定する。
 * Han は中国語にも当たるが、見分けるのは日本語かそれ以外かだけなので構わない。
 */
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const LATIN = /[A-Za-z]/;

/**
 * 数える文字数の上限。
 *
 * 会話は数万字になりうるが、言語の判定に全部は要らない。生成中は本文が
 * 伸び続けるので、走査そのものを軽く抑えておく。
 */
export const LANGUAGE_SAMPLE_LIMIT = 4000;

/**
 * 判定に足りる最小の文字数。
 *
 * 「OK」「はい」だけの短い会話で言語を決めつけると、次の発言で覆る。
 * 足りなければ判定しない（宣言を触らない）。
 */
export const LANGUAGE_MIN_SAMPLE = 40;

/**
 * 日本語とみなす下限の割合。
 *
 * 英語は1語あたりの文字数が多いので、日本語混じりの会話でも日本語の
 * 文字は少数派になりやすい。「日本語がほとんど無い」ときだけ英語と
 * 判定したいので、低めに置く。
 */
export const JAPANESE_MIN_RATIO = 0.1;

/**
 * @param texts 会話の本文（新しいものから順に渡すと、上限までで打ち切っても
 *   いま読んでいるあたりの言語が反映される）
 * @returns "ja" / "en"、判定できなければ null（宣言を触らない）
 */
export function detectContentLanguage(
  texts: Iterable<string>,
): "ja" | "en" | null {
  let japanese = 0;
  let latin = 0;
  let scanned = 0;

  for (const text of texts) {
    for (const ch of text) {
      if (scanned >= LANGUAGE_SAMPLE_LIMIT) break;
      scanned++;
      if (JAPANESE.test(ch)) japanese++;
      else if (LATIN.test(ch)) latin++;
    }
    if (scanned >= LANGUAGE_SAMPLE_LIMIT) break;
  }

  const letters = japanese + latin;
  if (letters < LANGUAGE_MIN_SAMPLE) return null;
  return japanese / letters >= JAPANESE_MIN_RATIO ? "ja" : "en";
}
