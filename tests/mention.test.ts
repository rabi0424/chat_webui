import { describe, expect, it } from "vitest";
import { applyMention, parseMention, stripMention } from "../app/lib/mention";

/**
 * 冒頭の宛先メンション（`@ボット名`）の読み方。
 *
 * ここが静かに壊れると、宛先が効いていないのに効いているように見える
 * （またはその逆）。名前は利用者が付ける自由文字列で、空白も記号も
 * 入るため、区切り文字では切り出せない——ボット名の側から前方一致で
 * 当てにいく方式が守られているかを見る。
 */
const bots = [
  { id: "b1", name: "翻訳" },
  { id: "b2", name: "翻訳（英語）" },
  { id: "b3", name: "My Bot" },
  { id: "b4", name: "検索係" },
];

const names = (list: { name: string }[]) => list.map((b) => b.name);

describe("宛先の採用", () => {
  it("名前を打ち切ると宛先になる", () => {
    const m = parseMention("@翻訳", bots);
    expect(m.bot?.id).toBe("b1");
    expect(m.replaceEnd).toBe(3);
  });

  it("名前の後ろに本文が続いていても採用する", () => {
    const m = parseMention("@翻訳 これを訳して", bots);
    expect(m.bot?.id).toBe("b1");
    // 本文はメンションの外（差し替えるのは `@翻訳` の3文字だけ）
    expect(m.replaceEnd).toBe(3);
  });

  it("区切りが無くても採用する（日本語には語の切れ目が無い）", () => {
    expect(parseMention("@翻訳これを訳して", bots).bot?.id).toBe("b1");
  });

  it("片方がもう片方の前方一致でも、長いほうを採る", () => {
    // 「翻訳」で止めると、括弧つきの名前を選べなくなる
    const m = parseMention("@翻訳（英語） これを", bots);
    expect(m.bot?.id).toBe("b2");
    expect(m.replaceEnd).toBe(1 + "翻訳（英語）".length);
  });

  it("名前に空白が入っていても最後まで採る", () => {
    const m = parseMention("@My Bot hello", bots);
    expect(m.bot?.id).toBe("b3");
    expect(m.replaceEnd).toBe(1 + "My Bot".length);
  });

  it("大小文字は無視する", () => {
    expect(parseMention("@my bot", bots).bot?.id).toBe("b3");
  });

  it("全角の＠でも読む", () => {
    expect(parseMention("＠翻訳", bots).bot?.id).toBe("b1");
  });

  it("冒頭でなければメンションではない", () => {
    expect(parseMention(" @翻訳", bots).present).toBe(false);
    expect(parseMention("これは @翻訳 の話", bots).present).toBe(false);
  });

  it("2行目の @ は拾わない", () => {
    expect(parseMention("本文\n@翻訳", bots).present).toBe(false);
  });

  it("名前が改行をまたぐことはない", () => {
    // 見るのは1行目まで。「翻」までは打ちかけとして読めるが、
    // 2行目の「訳」を足して「翻訳」と読むことはしない
    const m = parseMention("@翻\n訳", bots);
    expect(m.bot).toBeNull();
    expect(m.fragment).toBe("翻");
    expect(m.replaceEnd).toBe(2);
  });
});

describe("候補の絞り込み", () => {
  it("@ だけなら全件", () => {
    const m = parseMention("@", bots);
    expect(m.bot).toBeNull();
    expect(m.fragment).toBe("");
    expect(names(m.candidates)).toEqual(names(bots));
  });

  it("打ちかけの断片で絞る", () => {
    const m = parseMention("@翻", bots);
    expect(m.bot).toBeNull();
    expect(names(m.candidates)).toEqual(["翻訳", "翻訳（英語）"]);
    expect(m.replaceEnd).toBe(2);
  });

  it("打ち切ったあとも、より長い名前が候補に残る", () => {
    const m = parseMention("@翻訳", bots);
    expect(names(m.candidates)).toEqual(["翻訳", "翻訳（英語）"]);
  });

  it("名前として読めない書き出しなら、後ろに触れず全件を出す", () => {
    // 「検」は「検索係」の前方一致だが、1行目まるごとでは一致しない。
    // ここで断片として食べてしまうと、選んだときに「検」が消える
    const m = parseMention("@検討してほしいことがある", bots);
    expect(m.bot).toBeNull();
    expect(m.fragment).toBe("");
    expect(m.replaceEnd).toBe(1);
    expect(names(m.candidates)).toEqual(names(bots));
  });

  it("名前の無いボットは宛先にできない", () => {
    const m = parseMention("@", [{ id: "x", name: "" }, ...bots]);
    expect(m.bot).toBeNull();
    expect(names(m.candidates)).toEqual(names(bots));
  });
});

describe("候補を選んだときの本文", () => {
  it("打ちかけの断片は差し替える", () => {
    const text = "@翻";
    const next = applyMention(text, parseMention(text, bots), bots[0]);
    expect(next.text).toBe("@翻訳 ");
    expect(next.caret).toBe("@翻訳 ".length);
  });

  it("すでにある文章は冒頭に差し込むだけで残す", () => {
    const text = "@検討してほしいことがある";
    const next = applyMention(text, parseMention(text, bots), bots[3]);
    expect(next.text).toBe("@検索係 検討してほしいことがある");
    expect(next.caret).toBe("@検索係 ".length);
  });

  it("すでに空白が続いていれば二重にしない", () => {
    // 宛先の付け替え。差し替えたあとに空白が2つ並ばない
    const text = "@翻訳 これを訳して";
    const next = applyMention(text, parseMention(text, bots), bots[1]);
    expect(next.text).toBe("@翻訳（英語） これを訳して");
  });

  it("名前として読めるのは1行目まるごとのときだけ", () => {
    /*
      「@翻 これを訳して」は、1行目が名前の前方一致になっていない
      （名前に空白が入るボットもあるので、空白で切って読むことはしない）。
      打ちかけとして食べずに本文として残すので、選ぶと冒頭に差し込まれる。
      ここで「翻」を食べる作りにすると、`@検討してほしい` のような
      書き出しから1文字を静かに消してしまう。
    */
    const text = "@翻 これを訳して";
    const m = parseMention(text, bots);
    expect(m.fragment).toBe("");
    expect(applyMention(text, m, bots[0]).text).toBe("@翻訳 翻 これを訳して");
  });

  it("改行が続くときは空白を足さない", () => {
    const text = "@翻\n2行目";
    // 1行目が断片として読めるので、差し替えるのは1行目だけ
    const next = applyMention(text, parseMention(text, bots), bots[0]);
    expect(next.text).toBe("@翻訳\n2行目");
  });
});

describe("宛先の解除", () => {
  it("メンションと区切りの空白だけを落とす", () => {
    const text = "@翻訳 これを訳して";
    expect(stripMention(text, parseMention(text, bots))).toBe("これを訳して");
  });

  it("メンションが無ければ何もしない", () => {
    expect(stripMention("ふつうの文", parseMention("ふつうの文", bots))).toBe(
      "ふつうの文",
    );
  });
});
