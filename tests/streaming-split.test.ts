import { describe, expect, it } from "vitest";
import { splitStream } from "../app/components/StreamingMessage";

/**
 * 流れてくる本文を「確定した前半」と「まだ動く末尾」に切る。
 *
 * 守るべき性質はひとつ——**前半だけを描いても壊れて見えないこと**。
 * コードフェンスや数式の途中で切ると、前半が閉じないまま描かれる
 * （数式がそのまま生の記号で出る、コードが本文になる）。
 *
 * 数式は $$…$$ だけでなく \[…\] の書き方もあり、後者は見ていなかった。
 */

/** 短い本文は丸ごと「末尾」になるので、切らせるには嵩が要る。 */
const PAD = "これは前置きの文章です。".repeat(60);

/** 前半だけで閉じているか（描いても壊れないか）。 */
function headIsClosed(head: string): boolean {
  const fences = head.match(/^ {0,3}(?:`{3,}|~{3,})/gm)?.length ?? 0;
  const dollars = head.match(/\$\$/g)?.length ?? 0;
  const opens = head.match(/\\\[/g)?.length ?? 0;
  const closes = head.match(/\\\]/g)?.length ?? 0;
  return fences % 2 === 0 && dollars % 2 === 0 && opens === closes;
}

/** 実際に切れたか（前半が空でなく、末尾も残っている）。 */
function didSplit(text: string): boolean {
  const r = splitStream(text);
  return r.tail !== null && r.head !== "";
}

/**
 * 切ったときは、前半だけで閉じていなければならない。
 *
 * 切らなかったとき（tail が null）は全体をそのまま描くので、閉じて
 * いなくても構わない——切っていないのだから壊れようがない。
 */
describe("切ったなら、前半は閉じている", () => {
  const cases: [string, string][] = [
    ["閉じていないコードフェンス", `${PAD}\n\n\`\`\`js\nconst a = 1;`],
    ["閉じていないブロック数式（$$）", `${PAD}\n\n$$\n\\frac{1}{2}`],
    ["閉じていないブロック数式（\\[）", `${PAD}\n\n\\[\n\\frac{1}{2}`],
    ["2つめの数式が閉じていない", `${PAD}\n\n\\[a\\] と \\[b`],
    ["数式のあとに改行だけ来た", `${PAD}\n\n\\[\nx = 1\n`],
    // 切れ目（空行）が数式の内側に来る形。ここでガードが効かないと、
    // 前半が「開いたままの数式」で終わる
    ["空行を含む $$ 数式", `${PAD}\n\n$$\n\na = 1\n\n$$`],
    ["空行を含む \\[…\\] 数式", `${PAD}\n\n\\[\n\na = 1\n\n\\]`],
    ["改行を含む \\[…\\] 数式", `${PAD}\n\\[\na = 1\n\\]`],
  ];

  for (const [name, text] of cases) {
    it(name, () => {
      const r = splitStream(text);
      if (r.tail === null || r.head === "") return; // 切っていない
      expect(headIsClosed(r.head)).toBe(true);
      // 閉じていない部分は、描き直され続ける末尾のほうに残る
      expect(headIsClosed(r.head + r.tail)).toBe(false);
    });
  }
});

describe("切れるとき", () => {
  it("段落の切れ目で切る", () => {
    const r = splitStream(`${PAD}\n\nあと`);
    expect(r.tail).toBe("あと");
    expect(r.head.endsWith("\n\n")).toBe(true);
  });

  it("閉じたコードフェンスの後なら切れる", () => {
    expect(didSplit(`${PAD}\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\nあと`)).toBe(true);
  });

  it("閉じた $$ の後なら切れる", () => {
    expect(didSplit(`${PAD}\n\n$$ x = 1 $$\n\nあと`)).toBe(true);
  });

  it("閉じた \\[…\\] の後なら切れる", () => {
    expect(didSplit(`${PAD}\n\n\\[ x = 1 \\]\n\nあと`)).toBe(true);
  });

  it("素の角括弧は数式と見なさない", () => {
    // 配列やリンクの記法まで数式扱いすると、切れる場所が無くなる
    expect(didSplit(`${PAD}\n\n[1, 2, 3]\n\nあと`)).toBe(true);
  });
});

describe("切らないとき", () => {
  it("短い本文は丸ごと末尾（流入中として扱う）", () => {
    const r = splitStream("まだ何も終わっていない");
    expect(r.head).toBe("");
    expect(r.tail).toBe("まだ何も終わっていない");
  });

  it("閉じていないコードフェンスがあれば、そもそも切らない", () => {
    const text = `${PAD}\n\n\`\`\`js\nconst a = 1;`;
    expect(splitStream(text).tail).toBeNull();
  });

  it("空なら何もしない", () => {
    expect(splitStream("")).toEqual({ head: "", tail: null, tight: false });
  });

  it("長くて切れ目が無ければ、全体を前半として渡す", () => {
    const r = splitStream("あ".repeat(500));
    expect(r.tail).toBeNull();
    expect(r.head).toHaveLength(500);
  });
});
