/**
 * 宛先の候補（MentionSuggest）の位置と高さの決め方。
 *
 * 計算だけをここに出す（model-panel.ts・anchored-menu.ts と同じ理由——
 * jsdom では位置が全部 0 になり、DOM の中では検査にならない）。
 *
 * もとは「入力欄の上へ開く」だけだった。入力欄は画面の下端に居るので
 * それで足りていたが、同じ候補を**プロンプトの編集欄**でも出すように
 * なると前提が崩れる。編集欄は会話の途中、ときにはヘッダーのすぐ下に
 * 開くので、そこで上へ開くと候補が画面の外へ出る（何も出ていないのと
 * 同じに見える）。上下の空きを比べて、広いほうへ開く。
 */

/** 画面の縁に残す余白。 */
export const PANEL_MARGIN_PX = 8;
/** 入力欄との隙間。 */
export const PANEL_GAP_PX = 6;
/** 一覧の高さの上限（画面の比率）。 */
export const PANEL_MAX_RATIO = 0.5;

/** 基準になる入力欄の位置（`getBoundingClientRect()` の一部）。 */
export interface MentionAnchor {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

/** fixed 配置の座標。上へ開くときは bottom、下へ開くときは top を持つ。 */
export interface MentionPlacement {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function placeMentionPanel(
  anchor: MentionAnchor,
  view: { height: number },
): MentionPlacement {
  const margin = PANEL_MARGIN_PX;
  const gap = PANEL_GAP_PX;
  const wanted = view.height * PANEL_MAX_RATIO;
  const above = anchor.top - margin;
  const below = view.height - anchor.bottom - margin;

  // 迷ったら上。入力欄は画面の下端に居ることが多く、下に開くと
  // ソフトキーボードの下へ潜る
  if (above >= wanted || above >= below) {
    return {
      left: anchor.left,
      width: anchor.width,
      bottom: view.height - anchor.top + gap,
      // 空きを超える高さは返さない。ここを「最低◯px」で床上げして
      // いたころは、上が狭い場所（編集欄）で板が画面の上へはみ出した
      maxHeight: Math.max(0, Math.min(wanted, above - gap)),
    };
  }
  return {
    left: anchor.left,
    width: anchor.width,
    top: anchor.bottom + gap,
    maxHeight: Math.max(0, Math.min(wanted, below - gap)),
  };
}
