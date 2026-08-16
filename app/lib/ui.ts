/**
 * 共有UIスタイル。
 *
 * ガラス面（すりガラスのパネル）の質感はアプリ全体で統一する。
 * コンポーザー・ヘッダー・各ポップオーバーで同じ「素材」に見えるよう、
 * 透過度とブラーはここでだけ定義し、各コンポーネントはこれを合成する。
 */

/** ポップオーバー・パネル用のガラス面（角丸・配置・パディングは呼び出し側で指定）。 */
export const GLASS_PANEL =
  "border border-neutral-200/80 bg-white/80 shadow-lg shadow-black/10 " +
  "backdrop-blur-xl backdrop-saturate-150 dark:border-white/10 dark:bg-neutral-900/80";

/**
 * 液体ガラス風のボタン面。背景を透かしてぼかし、上端の映り込み
 * （GLASS_SHEEN）と縁のハイライトで厚みのあるガラスに見せる。
 * 角丸・大きさは呼び出し側で指定する。
 */
export const GLASS_BUTTON =
  "border border-neutral-200/80 bg-white/70 shadow-lg shadow-black/10 " +
  "backdrop-blur-xl backdrop-saturate-150 dark:border-white/15 dark:bg-white/10";

/** 主役のボタン用。同じガラスをアクセント色で染めたもの。 */
export const GLASS_ACCENT_BUTTON =
  "border border-white/30 bg-accent/85 text-accent-fg shadow-lg shadow-accent/30 " +
  "backdrop-blur-xl backdrop-saturate-150 dark:border-white/20";

/**
 * ガラス面の上半分に乗せる映り込み。
 * 親を relative + overflow-hidden にして重ねる。
 */
export const GLASS_SHEEN =
  "pointer-events-none absolute inset-x-0 top-0 h-1/2 " +
  "bg-gradient-to-b from-white/35 to-transparent";

/** ガラスの丸アイコンボタン（サイドバー下部のテーマ・設定）。 */
export const GLASS_ICON_BUTTON =
  "relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full " +
  "text-neutral-600 transition active:scale-95 dark:text-neutral-200 " +
  GLASS_BUTTON;
