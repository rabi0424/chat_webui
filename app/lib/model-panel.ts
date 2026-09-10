/**
 * モデル一覧（ModelPicker のパネル）の位置と高さの決め方。
 *
 * 計算だけをここに出す（anchored-menu.ts と同じ理由——jsdom では
 * 位置が全部 0 になり、DOM の中では検査できない）。
 *
 * 入力欄の中のチップから開くと、一覧はチップの上へ出る。iPhone で一覧の
 * 検索欄を押すとソフトキーボードが上がるが、position: fixed の板は
 * レイアウトビューポート基準のまま動かないので、板の下半分がキーボードの
 * 下に隠れていた（検索結果が1件だとまるごと隠れる）。visualViewport で
 * 「いま見えている範囲」を受け取り、板をその中に収める——下端は
 * キーボードの上、上端は見えている範囲の上端より下。
 */

/** 画面の縁に残す余白。 */
export const PANEL_MARGIN_PX = 8;
/** ボタンとの隙間。 */
export const PANEL_GAP_PX = 6;
/** 一覧の高さの上限（見えている範囲の比率）。上下どちらへ開くかの判断にも使う。 */
export const PANEL_MAX_RATIO = 0.6;
/**
 * 見えている範囲の下に、これ以上が隠れていればソフトキーボードとみなす。
 *
 * 小さな差は無視する。ホーム画面から開いた全画面表示では、起動直後の
 * visualViewport がステータスバーぶん（59px）短く報告される
 * （lib/app-height.ts）。それをキーボードと取ると、板がチップから
 * 59px 浮く。
 */
export const KEYBOARD_MIN_PX = 100;
/**
 * キーボードで狭いときに確保したい高さ。見えている範囲の6割では
 * 3行ほどしか入らず、残り4割に会話が見えていても検索中は役に立たない。
 */
export const PANEL_MIN_WANTED_PX = 384;

/** ボタンの位置（`getBoundingClientRect()` の一部）。 */
export interface PanelAnchor {
  top: number;
  bottom: number;
  left: number;
}

export interface PanelView {
  width: number;
  /** レイアウトビューポートの高さ（window.innerHeight）。fixed の基準。 */
  height: number;
  /** 見えている範囲の上端（visualViewport.offsetTop）。 */
  visualTop: number;
  /** 見えている範囲の高さ（visualViewport.height）。 */
  visualHeight: number;
}

/** fixed 配置の座標。上へ開くときは bottom、下へ開くときは top を持つ。 */
export interface PanelPlacement {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function placeModelPanel(
  anchor: PanelAnchor,
  view: PanelView,
): PanelPlacement {
  const margin = PANEL_MARGIN_PX;
  const gap = PANEL_GAP_PX;
  const width =
    view.width < 640 ? view.width - margin * 2 : Math.min(view.width * 0.9, 416);
  const left = Math.max(
    margin,
    Math.min(anchor.left, view.width - width - margin),
  );

  const hiddenBelow = view.height - (view.visualTop + view.visualHeight);
  const keyboard = hiddenBelow >= KEYBOARD_MIN_PX;
  const areaTop = keyboard ? view.visualTop : 0;
  const areaBottom = keyboard ? view.visualTop + view.visualHeight : view.height;
  const areaHeight = areaBottom - areaTop;
  const wanted = keyboard
    ? Math.max(
        areaHeight * PANEL_MAX_RATIO,
        Math.min(PANEL_MIN_WANTED_PX, areaHeight - margin * 2),
      )
    : areaHeight * PANEL_MAX_RATIO;

  // ボタンがキーボードの下に隠れているなら、見えている範囲の下端を
  // ボタンの代わりにする（板の下端がキーボードの上に付く）
  const anchorTop =
    anchor.top > areaBottom - margin ? areaBottom - margin + gap : anchor.top;
  const anchorBottom = Math.min(anchor.bottom, areaBottom);
  const below = areaBottom - anchorBottom - margin;
  const above = anchorTop - areaTop - margin;

  // 下に入りきらなくても、上より下のほうが広いなら下に出す
  if (below >= wanted || below >= above) {
    return {
      left,
      width,
      top: anchorBottom + gap,
      maxHeight: Math.min(wanted, below - gap),
    };
  }
  return {
    left,
    width,
    bottom: view.height - (anchorTop - gap),
    maxHeight: Math.min(wanted, above - gap),
  };
}
