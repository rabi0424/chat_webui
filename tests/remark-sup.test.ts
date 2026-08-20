import { describe, expect, it } from "vitest";
import { remarkSup } from "../app/lib/remark-sup";
import type { Root } from "mdast";

/**
 * 上付き（`^…^`）の変換。
 *
 * `^` は冪乗の記法として平文にもよく現れる。拾いすぎると、ただの
 * 数式めいた文が上付きに化けて本文が崩れる。
 */
function run(text: string) {
  const tree: Root = {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
  };
  (remarkSup() as (t: Root) => void)(tree);
  const para = tree.children[0] as { children: { type: string; data?: { hName?: string } }[] };
  return {
    // 上付きになった部分の中身
    sups: para.children
      .filter((c) => c.data?.hName === "sup")
      .map((c) => ((c as { children: { value: string }[] }).children[0]?.value ?? "")),
    // 変換後の本文（上付きも中身だけ連結）
    text: para.children
      .map((c) =>
        c.data?.hName === "sup"
          ? (c as { children: { value: string }[] }).children[0]?.value
          : (c as { value?: string }).value,
      )
      .join(""),
  };
}

describe("上付きにするもの", () => {
  it("記号や短い語を上付きにする", () => {
    expect(run("面積は 5m^2^ です").sups).toEqual(["2"]);
    expect(run("注^1^").sups).toEqual(["1"]);
    expect(run("Na^+^ と Cl^-^").sups).toEqual(["+", "-"]);
  });

  it("1行に複数あっても、それぞれを拾う", () => {
    expect(run("x^2^ + y^2^ = z^2^").sups).toEqual(["2", "2", "2"]);
  });
});

describe("上付きにしないもの", () => {
  it("冪乗の書き方を巻き込まない", () => {
    // 中に空白を許していた頃は「10 と 3」がまるごと上付きになっていた
    expect(run("2^10 と 3^5").sups).toEqual([]);
    expect(run("2^10 と 3^5").text).toBe("2^10 と 3^5");
  });

  it("数式めいた平文を壊さない", () => {
    for (const src of ["x^2 + y^2", "a^n - b^n", "2^31 - 1 は素数"]) {
      expect(run(src).sups, src).toEqual([]);
      expect(run(src).text, src).toBe(src);
    }
  });

  it("空の上付きは作らない", () => {
    expect(run("^^").sups).toEqual([]);
    expect(run("^ ^").sups).toEqual([]);
  });

  it("行をまたがない", () => {
    expect(run("^あ\nい^").sups).toEqual([]);
  });

  it("単独の ^ は素通しする", () => {
    expect(run("2^10").text).toBe("2^10");
    expect(run("キャレット ^ 単独").text).toBe("キャレット ^ 単独");
  });
});
