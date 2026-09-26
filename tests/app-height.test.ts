import { describe, expect, it } from "vitest";
import { appHeightValue } from "../app/lib/app-height";

/**
 * ホーム画面から開いた全画面表示では、実測値がどうであれ 100vh。
 * 起動直後の実測値はステータスバーぶん短く、そのまま使うと入力欄が
 * 画面の下端より 59pt 上で止まる（実際に起きた）。
 */
describe("アプリの高さ", () => {
  it("全画面表示では実測値を使わず 100vh", () => {
    expect(appHeightValue({ standalone: true, measured: 793 })).toBe("100vh");
    // 実測値が大きくても使わない（「大きいほう」では直らなかった）
    expect(appHeightValue({ standalone: true, measured: 900 })).toBe("100vh");
  });

  it("Safari では実測値を px で使う", () => {
    expect(appHeightValue({ standalone: false, measured: 664 })).toBe("664px");
    expect(
      appHeightValue({ standalone: false, measured: 664, overflow: 0 }),
    ).toBe("664px");
  });

  /**
   * Safari の実測値が文書のスクロール範囲より大きいと、画面ごと少し
   * スクロールでき、下まで送ると上端がステータスバーの裏へ隠れた。
   * はみ出した分だけ縮める。
   */
  it("はみ出した分だけ縮める", () => {
    expect(
      appHeightValue({ standalone: false, measured: 712, overflow: 20 }),
    ).toBe("692px");
    // 負のはみ出し（届いていない）で伸ばさない——起動直後に短すぎる問題は
    // 別の話で、ここで伸ばすと文書がまたスクロールできるようになる
    expect(
      appHeightValue({ standalone: false, measured: 712, overflow: -30 }),
    ).toBe("712px");
    // 全画面表示は 100vh のまま（はみ出しの補正を持ち込まない）
    expect(
      appHeightValue({ standalone: true, measured: 712, overflow: 20 }),
    ).toBe("100vh");
  });
});
