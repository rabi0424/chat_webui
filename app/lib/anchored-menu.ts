/**
 * 「…」ボタンに合わせて置くポップオーバーの、位置の決め方。
 *
 * 計算だけをここに出す。ブラウザでしか測れない値（ボタンの位置・板の
 * 大きさ・画面の大きさ）を受け取って座標を返すだけにしておけば、
 * 「画面の外へ出ていないか」を実際の数字で確かめられる——DOM の中に
 * 埋めたままだと、jsdom では何もかも 0 になって検査にならない。
 */

/** ボタンの位置（`getBoundingClientRect()` の一部）。 */
export interface AnchorRect {
  top: number;
  bottom: number;
  right: number;
}

/** ボタンとの隙間。 */
export const MENU_GAP_PX = 6;
/** 画面の縁に残す余白。 */
export const MENU_MARGIN_PX = 8;

/**
 * 板の左上を決める。
 *
 * 横は右端をボタンの右端に揃える（メニューはボタンからぶら下がって
 * 見えるほうが分かりやすい）。ただし板のほうがボタンより広いので、
 * 左の列ではそのままだと画面の外へ出る。はみ出すぶんは画面の内側へ
 * 寄せる——左右どちらの縁でも、板は必ず画面に収まる。
 *
 * 縦は下に開く。入らなければボタンの上へ返す。上下どちらにも入らない
 * ときは上端を余白に置く（画面より高い板は上から見せる）。
 */
export function placeAnchoredMenu(
  anchor: AnchorRect,
  panel: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.max(
    MENU_MARGIN_PX,
    Math.min(anchor.right - panel.width, view.width - panel.width - MENU_MARGIN_PX),
  );
  const below = view.height - anchor.bottom - MENU_MARGIN_PX;
  const above = anchor.top - MENU_MARGIN_PX;
  // 下に入りきらなくても、上より下のほうが広いなら下に出す（切れる量が少ない）
  const top =
    below >= panel.height + MENU_GAP_PX || below >= above
      ? anchor.bottom + MENU_GAP_PX
      : Math.max(MENU_MARGIN_PX, anchor.top - MENU_GAP_PX - panel.height);
  return { left, top };
}

/** ボタンごと画面の外へ流れたか（そのときはメニューを閉じる）。 */
export function anchorIsOffscreen(anchor: AnchorRect, viewHeight: number): boolean {
  return anchor.bottom < 0 || anchor.top > viewHeight;
}
