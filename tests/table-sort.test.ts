import { describe, expect, it } from "vitest";
import {
  comparatorFor,
  numeric,
  tsvCell,
} from "../app/components/MarkdownTable";

/**
 * 表の並べ替え。
 *
 * 元は「セルごとに、数なら数として・そうでなければ文字として」比べて
 * いた。数と文字が混ざる列では比べ方が組み合わせによって変わり、
 * **並びが一意に決まらなかった**。
 *
 * 数の拾い方も雑で、文字列のどこかにある数を1つ取っていた
 * （「2024-01-15」→ 2024、「v2.0」→ 2）。
 */
const sorted = (values: string[]) =>
  [...values].sort(comparatorFor(values));

describe("数として読めるもの", () => {
  it("素の数", () => {
    expect(numeric("42")).toBe(42);
    expect(numeric("-3.5")).toBe(-3.5);
  });

  it("桁区切りと単位が付いていても読む", () => {
    expect(numeric("1,234円")).toBe(1234);
    expect(numeric("約 5 件")).toBe(5);
    expect(numeric("￥1,234")).toBe(1234);
  });

  it("全角の数字を読む", () => {
    expect(numeric("１２３")).toBe(123);
    expect(numeric("１，２３４円")).toBe(1234);
  });

  it("引き算の記号（U+2212）も符号として読む", () => {
    expect(numeric("−5")).toBe(-5);
    expect(numeric("－5")).toBe(-5);
  });
});

describe("数として読まないもの", () => {
  it("日付は年だけで並べない", () => {
    expect(numeric("2024-01-15")).toBeNull();
  });

  it("版番号は最初の数で並べない", () => {
    expect(numeric("1.2.3")).toBeNull();
  });

  it("語中のハイフンは符号ではない", () => {
    // 「商品-5」が -5 になると、正の数より前へ来てしまう
    expect(numeric("商品-5")).toBe(5);
  });

  it("数を含まないもの", () => {
    expect(numeric("該当なし")).toBeNull();
    expect(numeric("")).toBeNull();
    expect(numeric("—")).toBeNull();
  });
});

describe("列ごとに比べ方を決める", () => {
  it("すべて数の列は、数として並ぶ", () => {
    expect(sorted(["10", "9", "100", "2"])).toEqual(["2", "9", "10", "100"]);
  });

  it("単位付きでも数として並ぶ", () => {
    expect(sorted(["1,000円", "300円", "20,000円"])).toEqual([
      "300円",
      "1,000円",
      "20,000円",
    ]);
  });

  /**
   * これが直したかったところ。混ぜて比べないので並びが一意に決まる。
   *
   * 文字として比べるが numeric: true を付けてあるので、埋もれた数も
   * 桁で並ぶ（"9" が "10" より前）。「数の列に1つだけ注記が入った」
   * ような表でも、見た目の順番が壊れない。
   */
  it("数でないものが混ざったら、列ぜんぶを文字として比べる", () => {
    expect(sorted(["10", "9", "該当なし"])).toEqual(["9", "10", "該当なし"]);
  });

  /**
   * 「1つでも数があれば数の列」にすると、数でないセルどうしが
   * 全部同じ扱い（比較できない＝等しい）になり、そこの並びが
   * 元のままになってしまう。列に1つでも数でないものがあれば、
   * 列ぜんぶを文字として比べる。
   */
  it("数でないものどうしも、ちゃんと並ぶ", () => {
    expect(sorted(["10", "みかん", "あんず", "2"])).toEqual([
      "2",
      "10",
      "あんず",
      "みかん",
    ]);
  });

  it("文字の比較でも、末尾の数は数として並ぶ", () => {
    expect(sorted(["項目10", "項目2", "項目1"])).toEqual([
      "項目1",
      "項目2",
      "項目10",
    ]);
  });

  it("空欄は末尾に置く", () => {
    expect(sorted(["3", "", "1", "2"])).toEqual(["1", "2", "3", ""]);
    expect(sorted(["い", "", "あ"])).toEqual(["あ", "い", ""]);
  });

  /**
   * 全順序であること。どの2つを取り出しても大小が一貫していないと、
   * 並べる実装によって結果が変わる。
   */
  it("どの2つを比べても矛盾しない", () => {
    const values = ["10", "9", "該当なし", "2", "v1.0", ""];
    const cmp = comparatorFor(values);
    for (const a of values) {
      for (const b of values) {
        // 反対称性（+0 と -0 を区別したくないので足しておく）
        expect(Math.sign(cmp(a, b)) + 0).toBe(-Math.sign(cmp(b, a)) + 0);
        for (const c of values) {
          // 推移性
          if (cmp(a, b) < 0 && cmp(b, c) < 0) {
            expect(cmp(a, c)).toBeLessThan(0);
          }
        }
      }
    }
  });
});

/**
 * タブ区切りでのコピー。
 *
 * セルの中にタブや改行が入っていると、そのまま繋げた文字列は表計算側で
 * 別のマス・別の行として読まれ、**そこから先の列が丸ごとずれる**。
 * モデルが書く表では、セル内改行も箇条書きも珍しくない。
 */
describe("表計算へ貼るときのマス", () => {
  it("ふつうの文字はそのまま", () => {
    expect(tsvCell("りんご")).toBe("りんご");
    expect(tsvCell("1,234円")).toBe("1,234円");
    expect(tsvCell("")).toBe("");
  });

  it("タブを含むマスは囲む", () => {
    expect(tsvCell("あ\tい")).toBe('"あ\tい"');
  });

  it("改行を含むマスは囲む", () => {
    expect(tsvCell("1行目\n2行目")).toBe('"1行目\n2行目"');
    expect(tsvCell("1行目\r\n2行目")).toBe('"1行目\r\n2行目"');
  });

  it("引用符は2つ重ねて囲む", () => {
    expect(tsvCell('彼は"はい"と言った')).toBe('"彼は""はい""と言った"');
  });

  it("引用符だけでも囲む", () => {
    // 囲まずに出すと、表計算側が囲みの開始と誤読する
    expect(tsvCell('"')).toBe('""""');
  });

  it("囲んだものを読み戻せる", () => {
    const unquote = (s: string) =>
      s.startsWith('"') && s.endsWith('"')
        ? s.slice(1, -1).replace(/""/g, '"')
        : s;
    for (const original of ["あ\tい", "1\n2", '"x"', 'a"b\tc', "ふつう"]) {
      expect(unquote(tsvCell(original))).toBe(original);
    }
  });
});
