/**
 * 共有UIスタイル。
 *
 * ガラス面（すりガラスのパネル）の質感はアプリ全体で統一する。
 * コンポーザー・ヘッダー・各ポップオーバーで同じ「素材」に見えるよう、
 * 透過度とブラーはここでだけ定義し、各コンポーネントはこれを合成する。
 *
 * ガラスらしさは「背景が透けてぼける」ことだけで出す。落とす影や
 * 上端の映り込みを描き足すと、板が浮いて貼り付けたように見えて
 * かえって作り物っぽくなるため、影は輪郭がぼやける程度に留め、
 * ハイライトのグラデーションは持たせない。
 */

/** ポップオーバー・パネル用のガラス面（角丸・配置・パディングは呼び出し側で指定）。 */
export const GLASS_PANEL =
  "border border-neutral-200/80 bg-white/80 shadow-md shadow-black/5 " +
  "backdrop-blur-xl backdrop-saturate-150 dark:border-white/10 dark:bg-neutral-900/80";

/**
 * ガラスのボタン面。角丸・大きさは呼び出し側で指定する。
 * 一覧の上に重なるため、影ではなく縁の線と透過で面を示す。
 */
export const GLASS_BUTTON =
  "border border-neutral-200/80 bg-white/70 backdrop-blur-xl backdrop-saturate-150 " +
  "dark:border-white/15 dark:bg-white/10";

/** 主役のボタン用。同じガラスをアクセント色で染めたもの。 */
export const GLASS_ACCENT_BUTTON =
  "border border-white/20 bg-accent/90 text-accent-fg " +
  "backdrop-blur-xl backdrop-saturate-150 dark:border-white/15";

/** ガラスの丸アイコンボタン（サイドバー下部のテーマ・設定）。 */
export const GLASS_ICON_BUTTON =
  "grid h-11 w-11 shrink-0 place-items-center rounded-full " +
  "text-neutral-600 transition active:scale-95 dark:text-neutral-200 " +
  GLASS_BUTTON;
