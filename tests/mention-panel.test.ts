import { describe, expect, it } from "vitest";
import {
  PANEL_GAP_PX,
  PANEL_MARGIN_PX,
  PANEL_MAX_RATIO,
  placeMentionPanel,
  type MentionAnchor,
} from "../app/lib/mention-panel";

/**
 * 宛先の候補（`@ボット名`）を開く位置。
 *
 * 位置はブラウザでしか測れないので、計算だけを取り出して数字で見る
 * （jsdom では getBoundingClientRect が全部 0 になり、DOM の中では
 * 「画面の外へ出ている」ことに気づけない）。
 */

const VIEW = { height: 800 };

/** 板が実際に占める縦の範囲（fixed 配置を画面の座標に直す）。 */
function span(anchor: MentionAnchor): { top: number; bottom: number } {
  const at = placeMentionPanel(anchor, VIEW);
  if (at.top != null) return { top: at.top, bottom: at.top + at.maxHeight };
  const bottom = VIEW.height - at.bottom!;
  return { top: bottom - at.maxHeight, bottom };
}

/** 画面の下端に居る入力欄（コンポーザー）。 */
const COMPOSER: MentionAnchor = { top: 690, bottom: 760, left: 16, width: 400 };
/** 会話の途中に開く編集欄。ヘッダーのすぐ下にも来る。 */
const EDITOR_TOP: MentionAnchor = { top: 90, bottom: 220, left: 24, width: 360 };

describe("宛先の候補の位置", () => {
  it("入力欄の上へ開く（下はキーボードの側なので使わない）", () => {
    const at = placeMentionPanel(COMPOSER, VIEW);
    expect(at.top).toBeUndefined();
    expect(at.bottom).toBe(VIEW.height - COMPOSER.top + PANEL_GAP_PX);
    expect(at.left).toBe(COMPOSER.left);
    expect(at.width).toBe(COMPOSER.width);
  });

  it("上が狭ければ下へ回す（編集欄は会話の途中に開く）", () => {
    const at = placeMentionPanel(EDITOR_TOP, VIEW);
    expect(at.bottom).toBeUndefined();
    expect(at.top).toBe(EDITOR_TOP.bottom + PANEL_GAP_PX);
  });

  it("どこに開いても画面からはみ出さない", () => {
    /*
      高さを「最低120px」で床上げしていたころは、空きがそれより狭い
      場所で板が画面の外へ出ていた。入力欄を画面の上から下まで動かし、
      背の高さも変えて（長い発言を書き直している編集欄は、画面の
      ほとんどを占める）、どの位置でも収まることを見る
    */
    for (const height of [40, 60, 200, 500, 700]) {
      for (let top = 0; top <= VIEW.height - height; top += 10) {
        const { top: t, bottom: b } = span({
          top,
          bottom: top + height,
          left: 0,
          width: 300,
        });
        expect(t).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(VIEW.height);
      }
    }
  });

  it("空きがあるときは画面の半分まで使う", () => {
    expect(placeMentionPanel(COMPOSER, VIEW).maxHeight).toBe(
      VIEW.height * PANEL_MAX_RATIO,
    );
  });

  it("狭い側しか無ければ、その空きのぶんだけ開く", () => {
    // 上下とも狭い（画面の中ほどの、背の高い編集欄）
    const anchor = { top: 300, bottom: 560, left: 0, width: 300 };
    const at = placeMentionPanel(anchor, VIEW);
    // 上（300）より下（800-560=240）のほうが狭いので上へ開く
    expect(at.bottom).toBeDefined();
    expect(at.maxHeight).toBe(anchor.top - PANEL_MARGIN_PX - PANEL_GAP_PX);
  });
});
