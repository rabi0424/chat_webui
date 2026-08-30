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
 * **ただし宣言だけでは足りない。** Safari は宣言を鵜呑みにせず、文書に入って
 * いる文字を自分で数える。器だけを返していたころ、英語の会話を開いても HTML に
 * 入っていた文字は画面まわりの日本語73字だけで、`lang="en"` と宣言しても
 * 翻訳ボタンは出なかった。そこで `languageSample()` が拾った——つまり宣言の
 * 元にしたのと同じ——本文を、サーバーも素のテキストとして HTML へ出す
 * （`app/components/chat/PlainMessages.tsx`）。宣言と、ブラウザが実際に読める
 * 文字とを、同じところから出すための分け方になっている。
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

/** 判定できないとき、および会話を開いていないときに宣言する言語。 */
export const DEFAULT_DOCUMENT_LANGUAGE = "ja";

/**
 * 判定に使う本文を、新しい発言から上限まで拾う。
 *
 * 返すのは**古い順**（画面に並べる順）。判定するだけなら順序は要らないが、
 * この同じ並びをサーバーが HTML へ描くのに使うため（下記）、拾った時点で
 * 表示の順に直しておく。
 *
 * 発言は途中で切らず、上限に届いた時点の1件までを丸ごと入れる。切ると
 * 文の途中から始まる本文が画面に出てしまう。1件が長すぎる場合だけは
 * その中で切る（1件で数万字になりうるので、上限が効かなくなる）。
 */
export function languageSample<T extends { content?: string }>(
  messages: T[] | undefined | null,
  limit: number = LANGUAGE_SAMPLE_LIMIT,
): { message: T; text: string }[] {
  if (!messages) return [];
  const picked: { message: T; text: string }[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0 && total < limit; i--) {
    const message = messages[i];
    const content = message?.content;
    // 本文の無い行（画像だけの発言・生成待ちの空欄）は飛ばす。飛ばしたぶん
    // 位置がずれるので、拾った本文には**その行そのもの**を添えて返す
    // （呼び出し側が末尾から数え直すと、空欄の手前で1件ずれる）。
    if (typeof content !== "string" || !content) continue;
    const text = content.length > limit ? content.slice(0, limit) : content;
    picked.push({ message, text });
    total += text.length;
  }
  return picked.reverse();
}

/**
 * 会話から、文書に宣言する言語を決める。
 *
 * **サーバーが返す HTML に載せる**ためのもの。描画後に書き換えるだけでは
 * 間に合わない——Safari は読み込んだ時点の文書を見て翻訳の要否を決めるので、
 * そのとき `ja` と書いてあれば、あとから直しても翻訳は出てこない。
 *
 * 見るのは `languageSample()` が拾った範囲——**サーバーが HTML へ描く本文と
 * 同じもの**にする。宣言と、ブラウザが実際に読める文字とが食い違うと、
 * Safari は自分で数えたほうを採る（宣言だけ `en` にしても翻訳は出ない）。
 */
export function conversationLanguage(
  messages: { content?: string }[] | undefined | null,
): string {
  if (!messages || messages.length === 0) return DEFAULT_DOCUMENT_LANGUAGE;
  // 拾った並びは表示順（古い順）なので、数えるときは新しい側へ戻す。
  // `languageSample()` は上限に届いた1件を丸ごと入れるぶん行き過ぎることが
  // あり、古い順のまま数えると、そこで打ち切られて**古いほうだけ**を見て
  // 決めてしまう（会話の途中で言語が変わったとき、宣言が前の言語で止まる）。
  const texts = languageSample(messages).map((s) => s.text);
  texts.reverse();
  return detectContentLanguage(texts) ?? DEFAULT_DOCUMENT_LANGUAGE;
}
