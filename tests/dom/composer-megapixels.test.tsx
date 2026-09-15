import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { installServer, renderChat, type ServerStub } from "./helpers/chat-harness";
import { RUNWARE_IMAGE_SETTING_KEYS, SIZE_FROM_INPUT_KEY } from "../../app/lib/params";
import type { ModelInfo } from "../../app/lib/openrouter.server";
import { PNG_40x24 } from "../fixtures/images";

/**
 * 入力欄の画像の大きさが、⚙の見積もりまで届いているか。
 *
 * 「入力画像に合わせる」は、入力欄にいま並んでいる画像の解像度に倍率を
 * 掛ける。この結び付き（入力欄 → ⚙）が切れても**型は通り、画面には
 * エラーも出ない**——⚙が「画像がありません」と言い続けるだけで、
 * 送ってみるまで気づけない。ここで、実物の画像を1枚入れてから⚙を開き、
 * その画像の縦横が出ることを見る。
 *
 * 画像は本物の PNG。縮小（canvas）はブラウザの機能なのでテストからは
 * 動かせないが、**縮小そのものは起きる**（長辺2048まで縮む）ので、
 * ここでは「別の大きさの実体を返す」形で差し替える——入力欄に出る数も
 * ⚙の見積もりも、**選んだ元ファイルではなく、これから送られる実体**の
 * ほうでなければならない。縦横の読み取りは本物を走らせる。
 */
vi.mock("../../app/lib/image", async (orig) => {
  const actual = await orig<typeof import("../../app/lib/image")>();
  const { PNG_24x40 } = await import("../fixtures/images");
  return {
    ...actual,
    prepareImage: async () =>
      new File([PNG_24x40], "縮小後.png", { type: "image/png" }),
  };
});

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

let server: ServerStub;
beforeEach(() => {
  server = installServer();
  void server;
  localStorage.clear();
});

/** 本物の PNG を、入力欄が受け取る File の形で。 */
const realPng = () =>
  new File([PNG_40x24], "ねこ.png", { type: "image/png" });

function pickFile(container: HTMLElement, file: File) {
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe("入力欄の画像の MP", () => {
  it("添付した画像の大きさを、入力欄にその場で添える", async () => {
    const { container } = renderChat({
      models: [IMAGE_MODEL],
      initialModel: IMAGE_MODEL.id,
    });
    pickFile(container, realPng());

    const thumb = await screen.findByAltText("ねこ.png");
    // 40x24 は 0.00096MP。0.0MP と書くと「大きさが無い」と読めてしまう
    await waitFor(() => expect(screen.getByText("0.1MP未満")).toBeVisible());
    /*
     * 縦横そのものは、畳まずに title へ（一覧の見た目を崩さない）。
     * ここに出るのは**縮小後**の 24×40。元ファイル（40×24）を測って
     * いると、⚙の見積もりも実際より大きくなる
     */
    await waitFor(() => expect(thumb.parentElement?.title).toContain("24×40"));
  });

  it("⚙の見積もりは、入力欄にいま並んでいる画像から出る", async () => {
    const { container, user } = renderChat({
      models: [IMAGE_MODEL],
      initialModel: IMAGE_MODEL.id,
      initialParams: { [SIZE_FROM_INPUT_KEY]: "on", size_scale: 4 },
    });

    await user.click(screen.getByLabelText("生成パラメータ"));
    // まだ入力欄は空。固定のサイズで作られることを断っている
    expect(screen.getByText(/入力欄に画像があるときだけ効きます/)).toBeVisible();

    pickFile(container, realPng());

    // 添付したとたんに、その画像（縮小後の実体）の縦横から見積もりが出る
    await waitFor(() =>
      expect(screen.getByText(/入力 24×40/)).toHaveTextContent("× 4"),
    );
    // 24x40 の4倍は 96x160（0.015MP）。上流の下限（0.66MP）に届かないので
    // 広げた、という断りまで出る
    expect(screen.getByText(/下限に届くよう広げました/)).toBeVisible();
  });
});
