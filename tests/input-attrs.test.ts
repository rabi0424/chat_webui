import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROSE_INPUT, TERSE_INPUT } from "../app/lib/ui";

/**
 * 文字入力欄の属性（監査 F-21）。
 *
 * autocapitalize／autocomplete／spellcheck を書かないと、既定値は
 * ブラウザと OS が決める。同じ画面が端末によって違う打ち心地になり、
 * 検索欄で勝手に大文字化されると入力した語と一致しなくなる。
 *
 * 画面を動かして確かめるぶんは tests/dom/input-attrs.test.tsx にある。
 * こちらは「書き忘れた欄が無いか」を見る側——足したばかりの入力欄は
 * たいてい画面の奥にあって、動かして辿り着くのが難しい。属性が無くても
 * 画面には何も出ないので、抜けは自分では気づけない。
 */

/** 文字を打つ欄ではないので、この属性は要らない。 */
const NOT_TEXT = ["file", "checkbox", "radio", "number", "range", "color"];

interface Tag {
  file: string;
  line: number;
  name: string;
  source: string;
}

/** app 配下の .tsx から、input と textarea の開きタグを集める。 */
function collectTags(): Tag[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".tsx")) files.push(path);
    }
  };
  walk("app");

  const tags: Tag[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const name of ["input", "textarea"]) {
      const open = `<${name}`;
      let at = text.indexOf(open);
      while (at >= 0) {
        tags.push({
          file,
          line: text.slice(0, at).split("\n").length,
          name,
          source: text.slice(at, endOfTag(text, at)),
        });
        at = text.indexOf(open, at + 1);
      }
    }
  }
  return tags;
}

/**
 * 開きタグの終わりを探す。
 *
 * 素直に ">" を探すと、className={`...`} や onChange={(e) => ...} の
 * 中の ">" で切れてしまう。波かっこの深さと引用符の中かどうかを見て、
 * 属性の外に出ている ">" だけを終わりと見なす。
 */
function endOfTag(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i + 1;
  }
  throw new Error(`閉じていないタグ: ${text.slice(start, start + 40)}`);
}

const typeOf = (source: string): string | null =>
  /\btype="([a-z]+)"/.exec(source)?.[1] ?? null;

describe("文字入力欄の属性", () => {
  const tags = collectTags();

  /**
   * 数え損ねると「対象が0件なので全部通った」になる。タグを1つも
   * 拾えていないとき、下の it は素通りしてしまう。
   */
  it("app 配下の input と textarea を拾えている", () => {
    expect(tags.filter((t) => t.name === "input").length).toBeGreaterThanOrEqual(10);
    expect(tags.filter((t) => t.name === "textarea").length).toBeGreaterThanOrEqual(3);
    // 属性の中の ">" で切れていないこと（切れると type を読み損ねる）
    expect(tags.every((t) => t.source.trimEnd().endsWith(">"))).toBe(true);
  });

  it("文字を打つ欄はすべて、端末任せにしない指定を持っている", () => {
    const missing = tags
      .filter((t) => !NOT_TEXT.includes(typeOf(t.source) ?? ""))
      .filter(
        (t) =>
          !t.source.includes("{...PROSE_INPUT}") &&
          !t.source.includes("{...TERSE_INPUT}"),
      )
      .map((t) => `${t.file}:${t.line} <${t.name}>`);

    expect(missing).toEqual([]);
  });

  /**
   * 定数そのものの中身。どちらか片方の属性が抜けても、上のテストは
   * 「spread がある」で通ってしまう。
   */
  it("指定の中身は3つそろっている", () => {
    for (const bundle of [PROSE_INPUT, TERSE_INPUT]) {
      expect(Object.keys(bundle).sort()).toEqual([
        "autoCapitalize",
        "autoComplete",
        "spellCheck",
      ]);
      expect(bundle.autoComplete).toBe("off");
    }
    // 文章の欄は綴りを見てもらい、短い語句の欄では邪魔なので切る
    expect(PROSE_INPUT.spellCheck).toBe(true);
    expect(TERSE_INPUT.spellCheck).toBe(false);
    expect(PROSE_INPUT.autoCapitalize).toBe("sentences");
    expect(TERSE_INPUT.autoCapitalize).toBe("none");
  });
});
