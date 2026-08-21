/**
 * 引っぱって更新（pull to refresh）の共通の寸法。
 *
 * 会話フィード（Chat）と画像一覧（images）で同じ手ざわりにするため、
 * 数値はここに一本化する。見せ方は画面ごとに違う（会話は本文ごと
 * ずらし、一覧は上に余白を開く）ので、描画側は各画面が持つ。
 */

/** これだけ引いたら更新を実行する（px）。 */
export const PULL_TRIGGER_PX = 64;

/** 引っぱりの最大量（px）。これ以上は伸びない。 */
export const PULL_MAX_PX = 96;

/**
 * 引っぱりとみなすまでの遊び（px）。
 *
 * これが無いと、指が1px下へぶれただけで引っぱり扱いになり touchmove を
 * preventDefault してしまう。仕様上、打ち消されたタッチ列からは互換の
 * マウスイベント（= click）が出ない決まりで、WebKit はこれに従う。
 * 一覧や会話の先頭（scrollTop = 0）ではその条件がいつでも成立するので、
 * 指がわずかにぶれたタップが黙って消えることになる。
 * 遊びのぶんは通常のタップとして通し、超えてから引っぱりに移る。
 */
export const PULL_SLOP_PX = 14;

/** 更新中に印を留めておく位置（px）。 */
export const PULL_REST_PX = 44;

/**
 * 引っぱりに使わない要素。ボタンや入力欄の上から始まった指は、
 * 最初から通常のタップ・ドラッグとして扱う。
 */
export const PULL_IGNORE_SELECTOR =
  'button, a, input, textarea, select, label, summary, [role="button"]';
