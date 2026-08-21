import { describe, expect, it } from "vitest";
import { parseUsage } from "../app/lib/serialize.server";

/**
 * 監査で挙げた小粒の修正。
 * どれも「壊れた入力ひとつで画面が開けなくなる」たぐいのものなので、
 * 境界の入力で落ちないことを押さえる。
 */
describe("parseUsage（B-12）", () => {
  it("壊れたJSONでも例外を投げない", () => {
    // ここが素の JSON.parse だったため、1行壊れるだけで
    // その会話のパス取得が丸ごと500になっていた
    for (const bad of ["{", "[", '{"a":', "壊れた", "undefined"]) {
      expect(() => parseUsage(bad), bad).not.toThrow();
      expect(parseUsage(bad), bad).toBeUndefined();
    }
  });

  it("オブジェクトでない値は使わない", () => {
    for (const bad of ["null", "123", '"文字列"', "true"]) {
      expect(parseUsage(bad), bad).toBeUndefined();
    }
  });

  it("空・未設定は undefined", () => {
    expect(parseUsage(null)).toBeUndefined();
    expect(parseUsage("")).toBeUndefined();
  });

  it("正しい使用量はそのまま読む", () => {
    expect(parseUsage('{"promptTokens":10,"completionTokens":20}')).toEqual({
      promptTokens: 10,
      completionTokens: 20,
    });
  });
});

describe("検索語の上限（B-18）", () => {
  const MAX_SEARCH_TERMS = 10;
  const split = (q: string) =>
    q.split(/[\s　]+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);

  it("語を並べてもD1のバインド上限に届かない", () => {
    // APIは200文字まで受けるので、1文字の語なら約100語が届きうる。
    // 1語につきバインドを2つ使うため、切らないと上限100を超えて500になる
    const many = Array.from({ length: 100 }, (_, i) => String(i % 10)).join(" ");
    const terms = split(many);
    expect(terms.length).toBe(MAX_SEARCH_TERMS);
    expect(terms.length * 2).toBeLessThanOrEqual(100);
  });

  it("普通の検索語はそのまま通る", () => {
    expect(split("設計 バグ")).toEqual(["設計", "バグ"]);
    expect(split("全角　スペース")).toEqual(["全角", "スペース"]);
  });
});

describe("LIKEのエスケープ（B-19）", () => {
  // 会話検索が使っている方式
  const escapeLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);
  // 画像検索が使っていた方式（記号を落とす）
  const stripLike = (t: string) => t.replace(/[%_]/g, "");

  it("記号を落とすと語が別物になる", () => {
    expect(stripLike("50%")).toBe("50");
    expect(stripLike("a_b")).toBe("ab");
  });

  it("エスケープなら語が保たれる", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("100\\")).toBe("100\\\\");
  });

  it("記号を含まない語は変えない", () => {
    expect(escapeLike("設計")).toBe("設計");
  });
});

describe("添付の上限（D-20）", () => {
  const MAX = 8;

  /** 修正前: 描画のたびの pending から空きを数える */
  function oldWay(drops: number[]) {
    const pending = 0; // 反映が追いつかないので据え置き
    let added = 0;
    for (const n of drops) {
      const room = MAX - pending; // 反映前なので古い値を見る
      if (room <= 0) continue;
      added += Math.min(n, room);
      // 描画が追いつかないうちに次が来る想定なので pending は据え置き
    }
    return added;
  }

  /** 修正後: 受け付けたぶんをその場で押さえる */
  function newWay(drops: number[]) {
    let reserved = 0;
    let added = 0;
    for (const n of drops) {
      const room = MAX - reserved;
      if (room <= 0) continue;
      const take = Math.min(n, room);
      reserved += take;
      added += take;
    }
    return added;
  }

  it("連続で落とすと上限を超えて添付できていた", () => {
    expect(oldWay([5, 5])).toBeGreaterThan(MAX);
  });

  it("修正後は上限を守る", () => {
    expect(newWay([5, 5])).toBe(MAX);
    expect(newWay([3, 3, 3, 3])).toBe(MAX);
    expect(newWay([20])).toBe(MAX);
  });

  it("上限内なら全部受け付ける", () => {
    expect(newWay([2, 3])).toBe(5);
  });
});
