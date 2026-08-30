import { describe, expect, it } from "vitest";
import {
  conversationLanguage,
  detectContentLanguage,
  languageSample,
  JAPANESE_MIN_RATIO,
  LANGUAGE_MIN_SAMPLE,
  LANGUAGE_SAMPLE_LIMIT,
} from "../app/lib/content-language";

/**
 * 会話の言語の判定。
 *
 * これを誤ると <html lang> に嘘を宣言することになり、Safari の翻訳が
 * 出てこない（今回直したかった不具合そのもの）か、日本語の会話に翻訳を
 * 勧められるかのどちらかになる。画面にはエラーが出ない。
 */

const EN =
  "The quick brown fox jumps over the lazy dog. This sentence is long enough to be judged as English text by the detector.";
const JA =
  "これは日本語の文章です。判定に足りるだけの長さがあり、ひらがなも漢字もカタカナも含んでいます。テストのために書かれた文章です。";

describe("会話の言語の判定", () => {
  it("英語の会話は en", () => {
    expect(detectContentLanguage([EN])).toBe("en");
  });

  it("日本語の会話は ja", () => {
    expect(detectContentLanguage([JA])).toBe("ja");
  });

  it("コードや記号だけでは判定しない（英語と決めつけない）", () => {
    // 記号は数に入らないので、足りる文字数に届かない
    expect(
      detectContentLanguage(["{ } ( ) => ; 123 456 !!! ### ---"]),
    ).toBeNull();
  });

  it("短すぎる会話では判定しない", () => {
    expect(detectContentLanguage(["OK"])).toBeNull();
    expect(detectContentLanguage(["はい"])).toBeNull();
    // 境目のすぐ下では判定せず、越えれば判定する
    expect(
      detectContentLanguage(["a".repeat(LANGUAGE_MIN_SAMPLE - 1)]),
    ).toBeNull();
    expect(detectContentLanguage(["a".repeat(LANGUAGE_MIN_SAMPLE)])).toBe("en");
  });

  it("日本語で聞いて英語で返ってきた会話は en（読みたいのは英語のほう）", () => {
    // 日本語の短い問いに、英語の長い応答。文字数では英語が大多数になる
    const reply = EN.repeat(4);
    expect(detectContentLanguage(["これを説明して", reply])).toBe("en");
  });

  it("英単語が混じる日本語の会話は ja のまま", () => {
    const mixed = "この API は REST で、response は JSON です。" + JA;
    expect(detectContentLanguage([mixed])).toBe("ja");
  });

  it("割合のしきい値どおりに切り替わる", () => {
    // 日本語1文字あたり、英字を何文字まで許すか
    const perJapanese = Math.round(1 / JAPANESE_MIN_RATIO) - 1;
    const enough = "あ".repeat(10) + "a".repeat(10 * perJapanese);
    expect(detectContentLanguage([enough])).toBe("ja");
    // 英字を増やして日本語の割合を下げると en へ落ちる
    const tooFew = "あ".repeat(10) + "a".repeat(10 * (perJapanese + 4));
    expect(detectContentLanguage([tooFew])).toBe("en");
  });

  it("上限までしか読まない（長い会話でも走査が伸びない）", () => {
    // **1つの本文の途中**で打ち切れるかを見る。文字列の境目でだけ止まる
    // 実装だと、長い1件の応答を最後まで走査してしまう
    const one = "a".repeat(LANGUAGE_SAMPLE_LIMIT) + "あ".repeat(100_000);
    expect(detectContentLanguage([one])).toBe("en");
    // 本文をまたぐ側も見る
    const texts = ["a".repeat(LANGUAGE_SAMPLE_LIMIT), "あ".repeat(100_000)];
    expect(detectContentLanguage(texts)).toBe("en");
  });

  it("渡した順に読む（呼ぶ側は新しいものから渡す）", () => {
    // 上限を超える量を先頭に置けば、後ろは読まれない
    const head = "あ".repeat(LANGUAGE_SAMPLE_LIMIT);
    expect(detectContentLanguage([head, "a".repeat(100_000)])).toBe("ja");
  });

  it("サロゲートペアの漢字も日本語として数える", () => {
    // 𠮟 は BMP の外。文字単位で回さないと2つに割れて数え損ねる
    const text = "𠮟".repeat(50) + "a".repeat(50);
    expect(detectContentLanguage([text])).toBe("ja");
  });
});

/**
 * 宣言の元にした本文は、そのままサーバーが HTML へ描く（PlainMessages）。
 *
 * 「宣言」と「ブラウザが実際に読める文字」が同じものから出ていないと、
 * Safari は自分で数えたほうを採る——`lang="en"` と書いてあっても、
 * 文書に日本語しか入っていなければ翻訳は出てこない。この不具合そのもの。
 */
describe("宣言と表示に使う本文を拾う", () => {
  const item = (content: string, role = "assistant") => ({ role, content });

  it("新しい側から拾い、画面に並べる順（古い順）で返す", () => {
    const sample = languageSample([item("1"), item("2"), item("3")]);
    expect(sample.map((s) => s.text)).toEqual(["1", "2", "3"]);
  });

  it("上限を超えたぶんの古い発言は拾わない", () => {
    const long = "a".repeat(LANGUAGE_SAMPLE_LIMIT);
    const sample = languageSample([item("古い"), item(long)]);
    // 末尾の1件で上限に届くので、その手前は入らない
    expect(sample.map((s) => s.text)).toEqual([long]);
  });

  it("1件が上限より長ければ、その中で切る", () => {
    const huge = "a".repeat(LANGUAGE_SAMPLE_LIMIT * 5);
    const [only] = languageSample([item(huge)]);
    expect(only.text).toHaveLength(LANGUAGE_SAMPLE_LIMIT);
  });

  it("本文の無い行を飛ばしても、本文と発言の対応がずれない", () => {
    // 画像だけの発言・生成待ちの空欄は本文を持たない。位置で数え直すと、
    // 空欄の手前で1件ずれて、こちらの発言が相手の吹き出しで出る
    const messages = [
      item("わたしの発言", "user"),
      item(""),
      item("相手の応答", "assistant"),
    ];
    const sample = languageSample(messages);
    expect(sample.map((s) => [s.message.role, s.text])).toEqual([
      ["user", "わたしの発言"],
      ["assistant", "相手の応答"],
    ]);
  });

  it("拾った本文を数えるときは、新しい側から数える", () => {
    /*
      拾う側は上限に届いた1件を丸ごと入れるので、拾った総量は上限を
      超えうる（ここでは 3999×2）。数える側にも同じ上限があるため、
      **どちらの端から数えるか**で答えが変わる:
        古い順のまま数える → 古い日本語を 3999 字読んだところで打ち切り、ja
        新しい側から数える → 新しい英語を 3999 字読んで、en
      会話の途中で言語が変わったとき、前者だと宣言が前の言語で止まる。
    */
    const almost = LANGUAGE_SAMPLE_LIMIT - 1;
    const messages = [item("あ".repeat(almost)), item("a".repeat(almost))];
    expect(languageSample(messages)).toHaveLength(2);
    expect(conversationLanguage(messages)).toBe("en");
  });
});
