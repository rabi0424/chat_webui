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

/**
 * メッセージに添える操作（編集・分岐・削除・引用・詳細）。
 *
 * ふだんは淡く、その吹き出しにポインタを載せたときだけ濃くする——
 * 読んでいる最中に操作が主張しないための作りだが、**ポインタを載せる
 * という動作が無い端末では、淡いまま**になる。iPhone では白地に
 * neutral-300（コントラスト比 約1.5:1）で、事実上見えていなかった。
 *
 * hover が無い環境では、最初から読める濃さで置く（neutral-500 は
 * 白地で 4.6:1、WCAG が非文字のUI部品に求める 3:1 を満たす）。
 * 押せる大きさも、指で使う端末でだけ広げる。
 */
const MSG_ACTION_BASE =
  "rounded text-neutral-300 group-hover/msg:text-neutral-400 " +
  "dark:text-neutral-700 dark:group-hover/msg:text-neutral-500 " +
  "touch:text-neutral-500 touch:dark:text-neutral-400";

/** アイコンだけの操作（編集・削除）。 */
export const MSG_ICON_ACTION =
  MSG_ACTION_BASE +
  " p-1 touch:p-2 hover:bg-neutral-100 hover:text-neutral-600 " +
  "dark:hover:bg-neutral-800 dark:hover:text-neutral-300";

/** 削除だけは、押したときに赤くする。 */
export const MSG_DELETE_ACTION =
  MSG_ACTION_BASE +
  " p-1 touch:p-2 hover:bg-neutral-100 hover:text-red-600 " +
  "dark:hover:bg-neutral-800 dark:hover:text-red-400";

/** 文字の操作（「⑂ ここから分岐」「この画像を使う」）。 */
export const MSG_TEXT_ACTION =
  MSG_ACTION_BASE +
  " px-1.5 py-0.5 text-xs touch:px-2 touch:py-1.5 " +
  "hover:bg-neutral-100 hover:text-neutral-600 " +
  "dark:hover:bg-neutral-800 dark:hover:text-neutral-300";

/**
 * 動きを控える設定になっているか。
 *
 * CSS の scroll-behavior は JS の scrollTo({behavior}) には効かない。
 * 指定した側が自分で見て決める必要がある。
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** 動きを控える設定なら即座に、そうでなければ滑らかに。 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
