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
