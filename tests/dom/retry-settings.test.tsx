import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { RetrySettings } from "../../app/components/RetrySettings";
import type { ParamsState } from "../../app/lib/params";
import {
  RETRY_ENABLED_KEY,
  RETRY_MAX_KEY,
  RETRY_SMART_KEY,
} from "../../app/lib/retry";

/**
 * 「成功するまで生成」の設定パネル。スマート連続生成のスイッチが
 * params の予約キーへ届き、並列数の欄が「上限」の意味に変わるか。
 *
 * スイッチの見た目だけ変わって params に載らないと、確認ダイアログも
 * サーバーも固定の並列数で走る。
 */
function Harness({ initial }: { initial: ParamsState }) {
  const [value, setValue] = useState<ParamsState>(initial);
  return (
    <>
      <RetrySettings value={value} onChange={setValue} ceiling={20} />
      <output data-testid="params">{JSON.stringify(value)}</output>
    </>
  );
}

const params = () =>
  JSON.parse(screen.getByTestId("params").textContent ?? "{}") as ParamsState;

describe("RetrySettings のスマート連続生成", () => {
  it("スイッチを入れると予約キーが立ち、並列数の欄が上限になる", () => {
    render(
      <Harness initial={{ [RETRY_ENABLED_KEY]: "on", [RETRY_MAX_KEY]: 5 }} />,
    );
    // 隣の欄は最初は「並列数」
    expect(screen.getByText("並列数")).toBeTruthy();
    expect(screen.queryByText("並列数の上限")).toBeNull();

    const sw = screen.getByRole("switch", { name: "スマート連続生成" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);

    expect(params()[RETRY_SMART_KEY]).toBe("on");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("並列数の上限")).toBeTruthy();
    expect(screen.queryByText("並列数")).toBeNull();
    // 未入力の並列数の既定は、目標数（1）ではなく上限の試行回数（5）
    expect(
      (screen.getByRole("spinbutton", { name: "並列数の上限" }) as HTMLInputElement)
        .placeholder,
    ).toBe("5");
  });

  it("切ると予約キーが消える（\"off\" を残さない）", () => {
    render(
      <Harness
        initial={{ [RETRY_ENABLED_KEY]: "on", [RETRY_SMART_KEY]: "on" }}
      />,
    );
    const sw = screen.getByRole("switch", { name: "スマート連続生成" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(RETRY_SMART_KEY in params()).toBe(false);
    expect(screen.getByText("並列数")).toBeTruthy();
  });

  it("本体を切ると畳まれる（スイッチが無いのは落ちているからではない）", () => {
    render(<Harness initial={{}} />);
    expect(screen.getByRole("switch", { name: "成功するまで生成" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "スマート連続生成" })).toBeNull();
  });
});
