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
  });
});
