import { describe, expect, it } from "vitest";
import {
  PANEL_GAP_PX,
  PANEL_MARGIN_PX,
  PANEL_MAX_RATIO,
  placeModelPanel,
} from "../app/lib/model-panel";

/**
 * モデル一覧の位置。
 *
 * iPhone で一覧の検索欄を押すとキーボードが上がるが、fixed の板は動かず
 * 下半分が隠れていた。見えている範囲（visualViewport）の中に収まるかを
 * 数字で確かめる（jsdom では位置が全部 0 になる）。
 */
const PHONE = { width: 390, height: 844 };
/** 入力欄の中のチップ。画面の下端近く。 */
const CHIP = { top: 780, bottom: 812, left: 60 };
/** キーボード（336px）が上がった状態。 */
const KEYBOARD = 336;

/** 板の上端と下端（レイアウト座標）。 */
function edges(p: ReturnType<typeof placeModelPanel>, viewHeight: number) {
  const bottom = p.bottom != null ? viewHeight - p.bottom : p.top! + p.maxHeight;
  return { top: bottom - p.maxHeight, bottom };
}

describe("モデル一覧の位置", () => {
  it("チップからは上へ開き、下端がチップに付く", () => {
    const p = placeModelPanel(CHIP, {
      ...PHONE,
      visualTop: 0,
      visualHeight: PHONE.height,
    });
    expect(p.bottom).toBe(PHONE.height - (CHIP.top - PANEL_GAP_PX));
    expect(p.top).toBeUndefined();
    expect(p.maxHeight).toBe(PHONE.height * PANEL_MAX_RATIO);
  });

  it("キーボードが上がったら、板はキーボードの上に、上端は画面の中に収まる", () => {
    const visualHeight = PHONE.height - KEYBOARD;
    const p = placeModelPanel(CHIP, { ...PHONE, visualTop: 0, visualHeight });
    const e = edges(p, PHONE.height);
    // 下端はキーボードの上
    expect(e.bottom).toBe(visualHeight - PANEL_MARGIN_PX);
    // 上端は見えている範囲の中
    expect(e.top).toBeGreaterThanOrEqual(PANEL_MARGIN_PX);
    // 結果が見えるだけの高さがある（6割＝305px では3行しか入らない）
    expect(p.maxHeight).toBeGreaterThanOrEqual(380);
  });

  it("Safari がページをずらしても（visualTop > 0）、見えている範囲の中に収まる", () => {
    const view = { ...PHONE, visualTop: 200, visualHeight: 400 };
    const p = placeModelPanel(CHIP, view);
    const e = edges(p, PHONE.height);
    expect(e.bottom).toBeLessThanOrEqual(600 - PANEL_MARGIN_PX);
    expect(e.top).toBeGreaterThanOrEqual(200 + PANEL_MARGIN_PX);
  });

  it("全画面表示の起動直後の短い visualViewport（59px）はキーボードと取らない", () => {
    const p = placeModelPanel(CHIP, {
      ...PHONE,
      visualTop: 0,
      visualHeight: PHONE.height - 59,
    });
    // チップに付いたまま（59px 浮かない）
    expect(p.bottom).toBe(PHONE.height - (CHIP.top - PANEL_GAP_PX));
  });

  it("設定画面の欄（画面の上のほう）からは下へ開く", () => {
    const p = placeModelPanel(
      { top: 120, bottom: 152, left: 40 },
      { ...PHONE, visualTop: 0, visualHeight: PHONE.height },
    );
    expect(p.top).toBe(152 + PANEL_GAP_PX);
    expect(p.bottom).toBeUndefined();
  });

  it("下へ開いた板も、キーボードの上で切り上げる", () => {
    const visualHeight = PHONE.height - KEYBOARD;
    const p = placeModelPanel(
      { top: 120, bottom: 152, left: 40 },
      { ...PHONE, visualTop: 0, visualHeight },
    );
    const e = edges(p, PHONE.height);
    expect(p.top).toBe(152 + PANEL_GAP_PX);
    expect(e.bottom).toBeLessThanOrEqual(visualHeight - PANEL_MARGIN_PX);
  });
});
