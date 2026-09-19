import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NumberInput } from "../../app/components/NumberInput";

/**
 * iPhone のキーパッド（監査 P-2）。
 *
 * `inputmode="numeric"` のキーパッドには小数点が無い。Poe の換算レート
 * （1pt ≈ $0.00002）のような欄は、これだと値を打ち込む手立てが無い。
 * 刻みが小数なら decimal にする。
 */
describe("数値欄のキーパッド", () => {
  it("刻みが整数なら numeric", () => {
    render(<NumberInput label="回数" value={3} step={1} onChange={() => {}} />);
    expect(screen.getByLabelText("回数").getAttribute("inputmode")).toBe("numeric");
  });

  it("刻みが小数なら decimal（小数点が打てる）", () => {
    render(<NumberInput label="レート" value={0.0001} step={0.0001} onChange={() => {}} />);
    expect(screen.getByLabelText("レート").getAttribute("inputmode")).toBe("decimal");
  });
});
