import { describe, expect, it } from "vitest";
import {
  MENU_GAP_PX,
  MENU_MARGIN_PX,
  anchorIsOffscreen,
  placeAnchoredMenu,
} from "../app/lib/anchored-menu";

/**
 * 「…」ボタンにぶら下げるポップオーバーの位置。
 *
 * 画像一覧のマスは、スマホで画面の1/3・デスクトップで1/6しか幅が無い。
 * メニュー（176px）は必ずマスからはみ出すので、画面の縁で切れないことは
 * 数字で確かめる（jsdom では何もかも 0 になり、DOM の中では検査できない）。
 */
const PANEL = { width: 176, height: 120 };
const PHONE = { width: 390, height: 844 };

describe("メニューの位置", () => {
  it("右端をボタンの右端に揃え、下にぶら下げる", () => {
    const { left, top } = placeAnchoredMenu(
      { top: 200, bottom: 224, right: 300 },
      PANEL,
      PHONE,
    );
    expect(left).toBe(300 - PANEL.width);
    expect(top).toBe(224 + MENU_GAP_PX);
  });

  it("左の列でも、板は画面の中に収まる", () => {
    // 3列の1列目。マスの右端は 130px しかなく、揃えると左が -46px になる
    const { left } = placeAnchoredMenu(
      { top: 100, bottom: 124, right: 130 },
      PANEL,
      PHONE,
    );
    expect(left).toBe(MENU_MARGIN_PX);
    expect(left + PANEL.width).toBeLessThanOrEqual(PHONE.width);
  });

  it("右端の列でも、板は画面の中に収まる", () => {
    // 最終列。ボタンは画面の右端すれすれに居る
    const { left } = placeAnchoredMenu(
      { top: 100, bottom: 124, right: PHONE.width - 2 },
      PANEL,
      PHONE,
    );
    expect(left + PANEL.width).toBe(PHONE.width - MENU_MARGIN_PX);
  });

  it("下に入らなければ、ボタンの上へ返す", () => {
    // 画面の一番下の行。下に残っているのは 20px しかない
    const anchor = { top: 800, bottom: 824, right: 300 };
    const { top } = placeAnchoredMenu(anchor, PANEL, PHONE);
    expect(top).toBe(anchor.top - MENU_GAP_PX - PANEL.height);
    expect(top + PANEL.height).toBeLessThanOrEqual(anchor.top);
  });

  it("上下どちらにも入らないときは、上端から見せる", () => {
    // 項目が増えて画面より高くなった板。ボタンは下のほう（上に返す側）に
    // あるので、素直に「上へ返す」と板の上端が -106px から始まる
    const tall = { width: 176, height: 800 };
    const { top } = placeAnchoredMenu(
      { top: 700, bottom: 724, right: 300 },
      tall,
      PHONE,
    );
    expect(top).toBe(MENU_MARGIN_PX);
  });

  it("下のほうが広ければ、入りきらなくても下に出す", () => {
    // 画面より高い板で、ボタンは上のほう。下も足りない（764px < 806px）が、
    // 上は 40px しかない。狭いほうへ返すと、ほとんど何も見えなくなる
    const tall = { width: 176, height: 800 };
    const anchor = { top: 48, bottom: 72, right: 300 };
    const { top } = placeAnchoredMenu(anchor, tall, PHONE);
    expect(top).toBe(anchor.bottom + MENU_GAP_PX);
  });
});

describe("ボタンが画面から出たか", () => {
  it("見えているあいだは閉じない", () => {
    expect(anchorIsOffscreen({ top: 0, bottom: 24, right: 300 }, 844)).toBe(false);
    expect(anchorIsOffscreen({ top: 820, bottom: 844, right: 300 }, 844)).toBe(false);
  });

  it("上へ流れても下へ流れても閉じる", () => {
    // スクロールでボタンがヘッダーの向こうへ消えた
    expect(anchorIsOffscreen({ top: -40, bottom: -16, right: 300 }, 844)).toBe(true);
    // 逆向きにスクロールして、画面の下へ抜けた
    expect(anchorIsOffscreen({ top: 900, bottom: 924, right: 300 }, 844)).toBe(true);
  });
});
