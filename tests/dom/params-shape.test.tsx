import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ParamsEditor } from "../../app/components/ParamsEditor";
import { POE_EXTRA_PREFIX, type ParamsState } from "../../app/lib/params";
import type { ModelInfo } from "../../app/lib/openrouter.server";

/**
 * 画像の形（アスペクト比・解像度）の選択。
 *
 * "1536x1024" と "1024x1536" は文字列としてほぼ同じ見た目で、選択肢に
 * 並べても縦長か横長かが分からない。長方形を描いて示すのがこの画面の
 * 役目なので、**描かれた長方形が値と同じ向きか**まで見る。文言だけ見ても、
 * 縦横を取り違えた図には気づけない。
 */
const IMAGE_BOT: ModelInfo = {
  id: "gpt-image-2",
  name: "GPT-Image-2",
  description: "テスト用の画像ボット",
  contextLength: 4096,
  promptPrice: "0",
  completionPrice: "0",
  inputModalities: ["text"],
  outputModalities: ["image"],
  supportedParameters: [],
  provider: "poe",
  botParameters: [
    {
      name: "size",
      options: ["auto", "1024x1024", "1536x1024", "1024x1536"],
      defaultValue: "auto",
    },
    {
      name: "quality",
      options: ["low", "medium", "high"],
      defaultValue: "low",
    },
  ],
} as ModelInfo;

const SIZE_KEY = `${POE_EXTRA_PREFIX}size`;

/** 本物と同じく、値を持って渡し直す（自動⇄手動の切り替えを本物で動かす）。 */
function Harness({ initial = {} }: { initial?: ParamsState }) {
  const [params, setParams] = useState<ParamsState>(initial);
  return (
    <>
      <ParamsEditor model={IMAGE_BOT} value={params} onChange={setParams} />
      <output data-testid="state">{JSON.stringify(params)}</output>
    </>
  );
}

/** 選択肢のボタンを、値の見出しから引く。 */
function option(value: string): HTMLElement {
  const found = screen
    .getAllByRole("radio")
    .find((b) => b.textContent?.startsWith(value));
  if (!found) throw new Error(`選択肢が見つからない: ${value}`);
  return found;
}

/** そのボタンが描いている長方形の縦横（px）。 */
function drawn(value: string): { w: number; h: number } {
  const rect = option(value).querySelector("rect");
  if (!rect) throw new Error(`長方形が描かれていない: ${value}`);
  return {
    w: Number(rect.getAttribute("width")),
    h: Number(rect.getAttribute("height")),
  };
}

describe("形の選択", () => {
  it("手動にすると、形の選択肢が長方形付きで並ぶ", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // 自動のあいだは <select> も選択肢も出ない（送らない設定なので）
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "sizeを手動設定" }));

    const group = screen.getByRole("radiogroup", { name: "size" });
    expect(group).toBeTruthy();
    // 選択肢は申告どおり4つ（"auto" も選べる形で残す）
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    // 形の選択に <select> は使わない
    expect(screen.queryByRole("combobox", { name: "size" })).toBeNull();
  });

  it("描く長方形の向きが、値の向きと一致する", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ [SIZE_KEY]: "auto" }} />);

    const landscape = drawn("1536x1024");
    const portrait = drawn("1024x1536");
    const square = drawn("1024x1024");

    expect(landscape.w).toBeGreaterThan(landscape.h);
    expect(portrait.h).toBeGreaterThan(portrait.w);
    expect(square.w).toBe(square.h);
    // 縦横を入れ替えただけの2つは、鏡写しの長方形になる
    expect(landscape.w).toBeCloseTo(portrait.h, 5);
    expect(landscape.h).toBeCloseTo(portrait.w, 5);

    await user.click(option("1024x1536"));
  });

  it("極端な比でも短辺が線に潰れない", () => {
    // 潰れると「読めない」ではなく「別の形」に見える（帯が直線になる）
    const banner = { ...IMAGE_BOT } as ModelInfo;
    banner.botParameters = [
      {
        name: "size",
        options: ["1536x128", "1024x1024"],
        defaultValue: "1536x128",
      },
    ];
    render(
      <ParamsEditor
        model={banner}
        value={{ [SIZE_KEY]: "1536x128" }}
        onChange={() => {}}
      />,
    );
    const { w, h } = drawn("1536x128");
    expect(h).toBeGreaterThanOrEqual(4);
    expect(w).toBeGreaterThan(h * 2);
  });

  it("比と向きを言葉でも添える", () => {
    render(<Harness initial={{ [SIZE_KEY]: "auto" }} />);
    // 解像度からは比が読み取れないので、約分した比と向きを併記する
    expect(option("1536x1024").textContent).toContain("3:2 横長");
    expect(option("1024x1536").textContent).toContain("2:3 縦長");
    expect(option("1024x1024").textContent).toContain("1:1 正方形");
  });

  it("読めない値（auto）は破線の四角にし、形を主張しない", () => {
    render(<Harness initial={{ [SIZE_KEY]: "auto" }} />);
    const auto = option("auto").querySelector("rect");
    expect(auto?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(
      option("1536x1024")
        .querySelector("rect")
        ?.getAttribute("stroke-dasharray"),
    ).toBeNull();
  });

  it("選んだものが選択状態になり、設定に入る", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ [SIZE_KEY]: "auto" }} />);

    expect(option("auto").getAttribute("aria-checked")).toBe("true");
    await user.click(option("1024x1536"));

    expect(option("1024x1536").getAttribute("aria-checked")).toBe("true");
    expect(option("auto").getAttribute("aria-checked")).toBe("false");
    expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual({
      [SIZE_KEY]: "1024x1536",
    });
  });

  it("自動に戻せる（形の行でも入口が消えない）", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ [SIZE_KEY]: "1024x1536" }} />);

    await user.click(screen.getByRole("button", { name: "sizeを自動に戻す" }));
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual({});
  });

  it("形でないパラメータは今までどおり <select> のまま", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "qualityを手動設定" }));
    expect(screen.getByRole("combobox", { name: "quality" })).toBeTruthy();
    // low/medium/high に長方形が付くと、意味の無い図が並ぶ
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });
});

/**
 * 自由入力の欄（Poeがパラメータを公開していないボット向け）。
 * ここでも打った値の向きをその場で返す。
 */
describe("自由入力の形の確認", () => {
  const BARE_BOT = { ...IMAGE_BOT, botParameters: undefined } as ModelInfo;

  function BareHarness() {
    const [params, setParams] = useState<ParamsState>({});
    return (
      <ParamsEditor model={BARE_BOT} value={params} onChange={setParams} />
    );
  }

  it("値が形として読めたときだけ、向きを添える", async () => {
    const user = userEvent.setup();
    render(<BareHarness />);

    await user.click(screen.getByRole("button", { name: "パラメータを追加" }));
    const valueInput = screen.getByLabelText("パラメータの値");

    await user.type(valueInput, "auto");
    expect(screen.queryByText("横長")).toBeNull();

    await user.clear(valueInput);
    await user.type(valueInput, "9:16");
    expect(screen.getByText("縦長")).toBeTruthy();
    // 「無いこと」だけでなく、欄そのものが生きていることも見る
    expect((valueInput as HTMLInputElement).value).toBe("9:16");
  });
});
