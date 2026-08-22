import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 実体（R2）を落とす場所が1か所に保たれているか（監査 B-10）。
 *
 * 分岐・フォークは実体を共有したまま行だけ複製する。参照が復活しうる
 * ので、落としてよいかの判断は**落とす直前**に1か所でだけ行う——控えた
 * 時点で判断して落とすと、そのあいだにフォークが走ったぶんを消して
 * しまい、行だけ残って画像が出ない状態になる（取り返しがつかない）。
 *
 * これは黙って壊れる種類の結び付きで、消してしまった画像は戻らないうえ、
 * 壊れたことも「あとで画像が出ない」という形でしか現れない。素直に
 * 書き直すと元の形（数えてすぐ落とす）に戻るので、見張っておく。
 */
const SOURCE = readFileSync("app/lib/db.server.ts", "utf8");

/** 名前で関数の本体を切り出す（この書き方では閉じ括弧が行頭に来る）。 */
function bodyOf(name: string): string {
  const at = SOURCE.indexOf(`function ${name}(`);
  expect(at, `${name} が見つからない`).toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n}\n", at);
  expect(end, `${name} の終わりが見つからない`).toBeGreaterThan(at);
  return SOURCE.slice(at, end);
}

/** import 文を除いた、実際の呼び出し箇所。 */
function callsTo(name: string): number {
  return (SOURCE.match(new RegExp(`(?<!import[^;]*)\\b${name}\\(`, "g")) ?? [])
    .length;
}

describe("実体を落とす場所", () => {
  it("db.server から R2 を落とすのは1か所だけ", () => {
    expect(callsTo("deleteFiles")).toBe(1);
  });

  it("その1か所は、猶予を過ぎた控えを片づけるところ", () => {
    expect(bodyOf("sweepPendingFileDeletions")).toContain("deleteFiles(");
  });

  it("落とす直前に、参照を数え直している", () => {
    const sweep = bodyOf("sweepPendingFileDeletions");
    const counted = sweep.indexOf("stillReferencedSql");
    const dropped = sweep.indexOf("deleteFiles(");
    expect(counted).toBeGreaterThan(-1);
    // 数えるのが先、落とすのが後
    expect(counted).toBeLessThan(dropped);
  });

  /**
   * 行を消す側は控えるだけ。ここが直接 R2 を触ると、猶予そのものが
   * 無くなる。
   */
  it("行を消す側は、控えるだけで落とさない", () => {
    for (const name of [
      "deleteConversation",
      "deleteAttachmentRows",
      "notePossiblyUnreferenced",
    ]) {
      const body = bodyOf(name);
      expect(body, name).not.toContain("deleteFiles(");
    }
    // 控える経路そのものは残っていること（消えていたら何も控えられない）
    expect(callsTo("notePossiblyUnreferenced")).toBeGreaterThanOrEqual(4);
  });
});
