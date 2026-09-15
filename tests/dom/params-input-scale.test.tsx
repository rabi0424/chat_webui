import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ParamsEditor } from "../../app/components/ParamsEditor";
import {
  RUNWARE_IMAGE_SETTING_KEYS,
  SIZE_FROM_INPUT_KEY,
  SIZE_SCALE_KEY,
  type ParamsState,
} from "../../app/lib/params";
import type { ModelInfo } from "../../app/lib/openrouter.server";

/**
 * 「入力画像に合わせる」の⚙。
 *
 * ここに出る数字は、そのまま上流へ送られる大きさである。**画面の数字と
 * 送る値が食い違っても、絵は出てしまう**ので、表示だけが間違っている
 * 壊れ方は気づかれない。出来上がりの縦横と MP が、入力欄の画像と倍率から
 * その場で出ていることを見る。
 */
const IMAGE_MODEL: ModelInfo = {
  id: "runware:vendor:family@1",
  name: "画像モデル",
  description: "テスト用",
  contextLength: 0,
  promptPrice: "0",
  completionPrice: "0",
  inputModalities: ["text", "image"],
  outputModalities: ["text", "image"],
  supportedParameters: [...RUNWARE_IMAGE_SETTING_KEYS],
  provider: "runware",
  runwareQuality: ["low", "medium", "high"],
  createdAt: 0,
} as ModelInfo;

function Harness({
  initial = {},
  inputImages = [],
}: {
  initial?: ParamsState;
  inputImages?: { imageSize?: { width: number; height: number } }[];
}) {
  const [params, setParams] = useState<ParamsState>(initial);
  return (
    <>
      <ParamsEditor
        model={IMAGE_MODEL}
        value={params}
        onChange={setParams}
        inputImages={inputImages}
      />
      <output data-testid="state">{JSON.stringify(params)}</output>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent || "{}");
const toggle = () => screen.getByRole("switch", { name: "入力画像に合わせる" });

describe("オン/オフ", () => {
  it("既定はオフで、倍率も出さない", () => {
    render(<Harness />);
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    // 何に掛かる数字か読めないので、オフのあいだは倍率を並べない
    expect(screen.queryByLabelText("倍率")).toBeNull();
  });

  it("オンにすると設定に残り、オフで消える", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    expect(state()[SIZE_FROM_INPUT_KEY]).toBe("on");
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    await user.click(toggle());
    expect(state()).not.toHaveProperty(SIZE_FROM_INPUT_KEY);
  });

  /**
   * オンのあいだ、固定のサイズは送られない。選んだ値は残って見えるので、
   * 効いていないことを画面に出す——**選び直しても何も変わらない**という
   * 形の分かりにくさを避ける。
   */
  it("オンのあいだ、固定のサイズは使わないと断る（選択肢は消さない）", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ size: "1024x1024" }} />);
    expect(screen.queryByText(/オンのあいだは使いません/)).toBeNull();
    await user.click(toggle());
    expect(screen.getByText(/オンのあいだは使いません/)).toBeVisible();
    // 断り書きの隣で、サイズの選択肢そのものは選べるまま残っている
    expect(
      screen.getByRole("radio", { name: /1024x1024/ }),
    ).toBeVisible();
  });
});

describe("出来上がりの大きさ（入力欄の画像から）", () => {
  const on = { [SIZE_FROM_INPUT_KEY]: "on", [SIZE_SCALE_KEY]: 2 };

  it("入力の縦横・MP と、出来上がりの縦横・MP を併記する", () => {
    render(
      <Harness
        initial={on}
        inputImages={[{ imageSize: { width: 1024, height: 768 } }]}
      />,
    );
    const line = screen.getByText(/入力 1024×768/);
    expect(line).toHaveTextContent("0.8MP");
    expect(line).toHaveTextContent("2048×1536");
    expect(line).toHaveTextContent("3.1MP");
  });

  it("倍率を変えると、その場で出来上がりが変わる", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={on}
        inputImages={[{ imageSize: { width: 1024, height: 768 } }]}
      />,
    );
    await user.selectOptions(screen.getByLabelText("倍率"), "3");
    expect(screen.getByText(/入力 1024×768/)).toHaveTextContent("3072×2304");
    expect(state()[SIZE_SCALE_KEY]).toBe(3);
  });

  /** 打ち間違いで桁が変わらないよう、倍率は決まった段からしか選べない。 */
  it("倍率は段から選ぶ（自由入力にしない）", () => {
    render(<Harness initial={on} />);
    const scale = screen.getByLabelText("倍率") as HTMLSelectElement;
    expect(scale.tagName).toBe("SELECT");
    expect([...scale.options].map((o) => o.value)).toEqual([
      "0.5",
      "1",
      "1.5",
      "2",
      "3",
      "4",
    ]);
  });

  /**
   * 倍率は入力画像に掛かるので、同じ「4倍」でも入力次第で桁が変わる。
   * 上限に当てたことを黙っていると、頼んだ大きさで作られたように見える。
   */
  it("上限に当てたときは、その旨を出す", () => {
    render(
      <Harness
        initial={{ [SIZE_FROM_INPUT_KEY]: "on", [SIZE_SCALE_KEY]: 4 }}
        inputImages={[{ imageSize: { width: 2048, height: 1536 } }]}
      />,
    );
    expect(screen.getByText(/上限（8.3MP）に収めました/)).toBeVisible();
    // 収めた結果も併記する（何MPで作られるのかが分かる）。50MP を頼んだ
    // ことは、この行を読むまで分からない
    const line = screen.getByText(/入力 2048×1536/);
    expect(line).toHaveTextContent("× 4");
    expect(line).toHaveTextContent("3312×2496（8.3MP）");
  });

  it("入力欄に画像が無ければ、固定のサイズで作られると断る", () => {
    render(<Harness initial={on} />);
    expect(screen.getByText(/入力欄に画像があるときだけ効きます/)).toBeVisible();
  });

  it("大きさを読み取れない画像でも、黙って倍率を効かせない", () => {
    render(<Harness initial={on} inputImages={[{}]} />);
    expect(screen.getByText(/読み取れませんでした/)).toBeVisible();
  });

  it("2枚以上あるときは、どれを基準にしたかを言う", () => {
    render(
      <Harness
        initial={on}
        inputImages={[
          { imageSize: { width: 1024, height: 768 } },
          { imageSize: { width: 4000, height: 3000 } },
        ]}
      />,
    );
    const line = screen.getByText(/入力 1024×768/);
    expect(line).toHaveTextContent("1枚目を基準");
    expect(line).toHaveTextContent("2048×1536");
  });
});
