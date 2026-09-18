import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 文書を溜めさせない配線。
 *
 * Safari はタブを復元するとき（アプリを終了して開き直したとき）、保存して
 * ある応答を**鮮度を確かめずに**そのまま使う。Cache-Control が無い応答は
 * 保存の対象なので、前に開いたときの会話がそのまま出る——最後のやり取りが
 * 抜けた状態で、再読み込みするまで直らない。
 *
 * この壊れ方は**画面には何も出ない**し、手元の開発でも起きない（開発中は
 * 文書を毎回読み込み直すため）。外れたことに気づく手立てをここに置く。
 *
 * ヘッダは「ブラウザが解釈して初めて効く」ものなので、付いていること自体は
 * 開発サーバーの応答を読んで確かめてある:
 *
 *   $ curl -sS -D - -o /dev/null http://localhost:5173/
 *   cache-control: no-store
 *   ...
 *   $ curl -sS -D - -o /dev/null http://localhost:5173/images.data
 *   content-type: text/x-script        ← 単一フェッチには付かない
 *   $ curl -sS -D - -o /dev/null http://localhost:5173/api/fx
 *   cache-control: private, max-age=3600  ← 自前で指定した経路はそのまま
 */

const entry = readFileSync("app/entry.server.tsx", "utf8");

describe("文書の Cache-Control", () => {
  it("文書には no-store を付ける", () => {
    expect(entry).toMatch(
      /responseHeaders\.set\(\s*"Cache-Control",\s*"no-store",?\s*\)/,
    );
  });

  /**
   * 溜めてよいことにすると、それが何秒であれタブの復元では効かない
   * （復元は鮮度を見ない）。`no-cache` も同じ理由で足りない——確かめる
   * 材料（ETag / Last-Modified）を文書には付けていないため。
   */
  it("溜めてよいとは言わない", () => {
    const value = entry.match(
      /responseHeaders\.set\(\s*"Cache-Control",\s*"([^"]+)"/,
    )?.[1];
    expect(value).toBe("no-store");
  });

  /**
   * 付けた先が、返す応答のヘッダであること。別の入れ物に入れても
   * 画面には何も出ないまま、ブラウザには届かない。
   */
  it("付けた先が、そのまま返る応答のヘッダになっている", () => {
    expect(entry).toMatch(/new Response\(body,\s*\{\s*headers:\s*responseHeaders/);
  });
});
