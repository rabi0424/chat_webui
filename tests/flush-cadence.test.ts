import { describe, expect, it } from "vitest";
import { flushInterval } from "../app/lib/flush-cadence";

/**
 * 途中経過を D1 へ保存する間隔。
 *
 * D1への保存はサブリクエストとして数えられ、1回の実行あたりの上限
 * （無料プランでは内部サービスへ1,000件）を超えると以降の保存が失敗する。
 * **失敗するのは途中経過だけではない**——最後の確定も同じ枠を使うので、
 * そこも通らなくなる。応答は「生成中」のまま残り、受け取った本文は
 * どこにも書かれずに消える。
 *
 * 以前は「300回まで0.5秒、あとはずっと2秒」で、30分の上限まで流れ
 * 続けると 1,125回になり枠を超えていた。
 */

/** 生成の実行が続いてよい上限（generation.server.ts の MAX_HEARTBEAT_MS）。 */
const MAX_RUN_MS = 30 * 60 * 1000;
/** 内部サービスへのサブリクエストの上限（無料プラン）。 */
const SUBREQUEST_LIMIT = 1000;

/** その時間ずっと流れ続けたとき、何回保存することになるか。 */
function flushesWithin(ms: number): number {
  let elapsed = 0;
  let flushes = 0;
  while (elapsed < ms) {
    elapsed += flushInterval(flushes);
    if (elapsed <= ms) flushes++;
  }
  return flushes;
}

describe("間隔の段", () => {
  it("序盤は細かい", () => {
    expect(flushInterval(0)).toBe(500);
    expect(flushInterval(299)).toBe(500);
  });

  it("回を重ねるごとに粗くなる", () => {
    expect(flushInterval(300)).toBe(2_000);
    expect(flushInterval(500)).toBe(10_000);
    expect(flushInterval(650)).toBe(30_000);
  });

  it("後戻りしない", () => {
    let prev = 0;
    for (let n = 0; n <= 1000; n += 10) {
      const cur = flushInterval(n);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("粗くしても止めはしない", () => {
    // この保存は停止要求を読む経路も兼ねている。間隔が無限になると
    // 停止ボタンが効かなくなる
    expect(flushInterval(100_000)).toBeLessThanOrEqual(60_000);
    expect(flushInterval(100_000)).toBeGreaterThan(0);
  });
});

describe("枠に収まるか", () => {
  /** これが本題。 */
  it("上限いっぱい流れても、サブリクエストの枠を使い切らない", () => {
    const flushes = flushesWithin(MAX_RUN_MS);
    // 確定・画像の取り込み・スキーマ適用のぶんを残す
    expect(flushes).toBeLessThan(SUBREQUEST_LIMIT * 0.75);
  });

  it("以前の作り（300回まで0.5秒、あとずっと2秒）なら超えていた", () => {
    const old = (ms: number) => {
      let elapsed = 0;
      let n = 0;
      while (elapsed < ms) {
        elapsed += n < 300 ? 500 : 2_000;
        if (elapsed <= ms) n++;
      }
      return n;
    };
    expect(old(MAX_RUN_MS)).toBeGreaterThan(SUBREQUEST_LIMIT);
  });

  it("よくある長さ（3分）では、今までどおり細かい", () => {
    // 粗くするのは長く続いたときだけ。ふつうの応答の見え方は変えない
    expect(flushesWithin(3 * 60 * 1000)).toBeGreaterThan(200);
  });
});
