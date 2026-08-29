import { describe, expect, it } from "vitest";
import {
  detectContentLanguage,
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
