import { describe, expect, it } from "vitest";
import {
  applyContentPayload,
  contentPayload,
  parseSince,
  pathFingerprint,
} from "../app/lib/polling";

/**
 * 生成中のポーリングで運ぶ量を減らす仕掛け。
 *
 * 壊れ方が静かなのが厄介なところ。差分の継ぎ足しを間違えると、本文が
 * 二重になる・欠ける形で画面に出るが、エラーにはならない。
 */

describe("since の読み取り", () => {
  it("数値を読む", () => {
    expect(parseSince("https://x/api?since=120")).toBe(120);
  });
  it("無指定・壊れた値・負数は 0（＝全文）に倒す", () => {
    for (const q of ["", "?since=", "?since=abc", "?since=-5", "?since=NaN"]) {
      expect(parseSince(`https://x/api${q}`)).toBe(0);
    }
  });
  it("小数は切り捨てる（slice の位置に使うため）", () => {
    expect(parseSince("https://x/api?since=10.9")).toBe(10);
  });
});

describe("返す本文を決める", () => {
  const TEXT = "あいうえおかきくけこ";

  it("伸びるだけの本文は、その先だけを返す", () => {
    const p = contentPayload(TEXT, 4, true);
    expect(p.contentDelta).toBe("おかきくけこ");
    expect(p.content).toBeUndefined();
    expect(p.contentLength).toBe(TEXT.length);
  });

  it("最初の1回（since=0）は全文", () => {
    const p = contentPayload(TEXT, 0, true);
    expect(p.content).toBe(TEXT);
    expect(p.contentDelta).toBeUndefined();
  });

  it("書き換わりうる本文は、差分にせず全文で返す", () => {
    // 進捗の見出し・確定後の要約がこれ。差分で返すと継ぎ足しが壊れる
    const p = contentPayload(TEXT, 4, false);
    expect(p.content).toBe(TEXT);
    expect(p.contentDelta).toBeUndefined();
  });

  it("手元のほうが長いと言われたら、追記は空", () => {
    const p = contentPayload(TEXT, 999, true);
    expect(p.contentDelta).toBe("");
    // 長さは正しく伝える。受け手はこれで食い違いに気づく
    expect(p.contentLength).toBe(TEXT.length);
  });
});

describe("受け取った本文の組み立て", () => {
  it("差分を継ぎ足す", () => {
    const full = applyContentPayload("あいうえ", {
      contentDelta: "おかきくけこ",
      contentLength: 10,
    });
    expect(full).toBe("あいうえおかきくけこ");
  });

  it("全文が来たらそれを使う（手元は捨てる）", () => {
    const full = applyContentPayload("古い本文", {
      content: "新しい本文",
      contentLength: 5,
    });
    expect(full).toBe("新しい本文");
  });

  it("長さが合わなければ null（取り直させる）", () => {
    // サーバー側で本文が縮んだ・書き直された場合。黙って継ぎ足すと壊れる
    expect(
      applyContentPayload("あいうえ", {
        contentDelta: "お",
        contentLength: 99,
      }),
    ).toBeNull();
    expect(
      applyContentPayload("あいうえ", { content: "短い", contentLength: 99 }),
    ).toBeNull();
  });

  it("サーバーと往復させても本文が一致する（伸びていく様子を再現）", () => {
    const source = "これは長い応答です。".repeat(50);
    let held = "";
    for (let n = 1; n <= source.length; n += 7) {
      const grown = source.slice(0, n);
      // 生成中なので差分で返る
      const payload = contentPayload(grown, held.length, true);
      const next = applyContentPayload(held, payload);
      expect(next).not.toBeNull();
      held = next!;
      expect(held).toBe(grown);
    }
    // 確定は全文で返る（要約に置き換わることがあるため）
    const finalPayload = contentPayload(source, held.length, false);
    expect(applyContentPayload(held, finalPayload)).toBe(source);
  });

  it("確定で本文が別物に置き換わっても追従できる", () => {
    let held = "途中まで書かれた本文";
    const replaced = "**完了** — 成功 3件";
    const payload = contentPayload(replaced, held.length, false);
    held = applyContentPayload(held, payload)!;
    expect(held).toBe(replaced);
  });
});

describe("パスの指紋", () => {
  const row = (
    id: string,
    status: string | null = null,
    flushed: number | null = null,
  ) => ({ id, status, flushed_at: flushed });

  it("同じ内容なら同じ札", () => {
    const a = [row("m1", "done", 100), row("m2", "streaming", 200)];
    const b = [row("m1", "done", 100), row("m2", "streaming", 200)];
    expect(pathFingerprint(a)).toBe(pathFingerprint(b));
  });

  it("本文が伸びる（書き込み時刻が動く）と変わる", () => {
    const before = [row("m1", "streaming", 200)];
    const after = [row("m1", "streaming", 201)];
    expect(pathFingerprint(after)).not.toBe(pathFingerprint(before));
  });

  it("確定した瞬間に変わる（時刻が同じでも）", () => {
    const before = [row("m1", "streaming", 200)];
    const after = [row("m1", "done", 200)];
    expect(pathFingerprint(after)).not.toBe(pathFingerprint(before));
  });

  it("枝を切り替えると変わる（件数が同じでも）", () => {
    const before = [row("m1", "done", 1), row("m2", "done", 2)];
    const after = [row("m1", "done", 1), row("m3", "done", 2)];
    expect(pathFingerprint(after)).not.toBe(pathFingerprint(before));
  });

  it("応答が積まれると変わる", () => {
    const before = [row("m1", "streaming", 1)];
    const after = [row("m1", "streaming", 1), row("m2", "done", 1)];
    expect(pathFingerprint(after)).not.toBe(pathFingerprint(before));
  });

  it("並びが入れ替わっただけでも変わる", () => {
    const a = [row("m1", "done", 1), row("m2", "done", 2)];
    const b = [row("m2", "done", 2), row("m1", "done", 1)];
    expect(pathFingerprint(a)).not.toBe(pathFingerprint(b));
  });

  it("ETag の形をしている", () => {
    expect(pathFingerprint([row("m1")])).toMatch(/^W\/"[\w-]+"$/);
  });
});
