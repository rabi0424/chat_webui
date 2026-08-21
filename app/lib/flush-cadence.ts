/**
 * 途中経過を D1 へ保存する間隔。
 *
 * 生成の本体（generation.server.ts）から切り出してある。あちらは
 * cloudflare:workers を読むので Workers の外からは触れないが、
 * 「何回目なら何ミリ秒あけるか」は数を返すだけの処理でしかない。
 */

/**
 * D1へ部分保存する間隔。ここがそのまま「本文が届く粒度」になる。
 * 短くすると表示は細かくなるが、そのぶんD1への書き込みと
 * クライアントのポーリング取得が増える（生成1回あたり数十回 → 百数十回）。
 * 表示の滑らかさは受け取ったあとの見せ方（StreamingMessage）で作るので、
 * ここは体感が変わる範囲で控えめに詰めている。
 */
const FLUSH_INTERVAL_MS = 500;

/**
 * 部分保存の間隔。回数が増えるほど粗くする。
 *
 * D1への保存もサブリクエストとして数えられ、1回の実行あたりの上限
 * （無料プランでは内部サービスへ1,000件）を超えると以降の保存が
 * 失敗する。**失敗するのは途中経過だけではない**——最後の確定も同じ
 * 枠を使うので、そこも通らなくなる。応答は「生成中」のまま残り、
 * 受け取った本文はどこにも書かれずに消える。
 *
 * 以前は「300回まで0.5秒、あとはずっと2秒」で、30分の上限まで
 * 流れ続けると 300 + 825 = 1,125回になり、枠を超えていた。回数に応じて
 * 段階的に伸ばし、上限（MAX_HEARTBEAT_MS）まで流れても 650回程度で
 * 収まるようにする。確定・画像の取り込み・スキーマ適用のぶんが残る。
 *
 * 粗くしても止めはしない。この保存は停止要求を読む経路も兼ねていて
 * （要件 §160）、間隔がそのまま停止の効きの速さになる。
 */
const FLUSH_LADDER: { until: number; interval: number }[] = [
  { until: 300, interval: FLUSH_INTERVAL_MS },
  { until: 500, interval: 2_000 },
  { until: 650, interval: 10_000 },
];

/** 段を過ぎたあとの間隔。ここまで来ることは実際にはほぼ無い。 */
const SLOW_FLUSH_INTERVAL_MS = 30_000;

/** これまでに保存した回数から、次までの間隔を決める。 */
export function flushInterval(flushes: number): number {
  for (const step of FLUSH_LADDER) {
    if (flushes < step.until) return step.interval;
  }
  return SLOW_FLUSH_INTERVAL_MS;
}
