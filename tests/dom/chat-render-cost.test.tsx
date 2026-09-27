import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  installServer,
  msg,
  renderChat,
  TEST_MODEL,
  type ServerStub,
} from "./helpers/chat-harness";
import type { ModelInfo } from "../../app/lib/openrouter.server";

/**
 * 会話の外側の操作で、吹き出しを描き直さないこと。
 *
 * ⚙パネル（生成パラメータ）の開け閉めや値の変更は Chat の状態を変えるので
 * Chat 全体が描き直される。以前はそのたびに会話の全吹き出しまで描き直して
 * いて、長い会話ではパネルの操作がもっさりしていた。画面の見た目は
 * 何も変わらないので、描いた回数を数えないと気づけない。
 *
 * 描き直さなくした仕掛け（一覧の memo と、同一性を保った関数）は、
 * 取り違えると「古い値のまま動く」形で壊れる。後半はその側を見る。
 */
const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../app/components/chat/AssistantMessage", async (orig) => {
  const actual =
    await orig<typeof import("../../app/components/chat/AssistantMessage")>();
  return {
    ...actual,
    AssistantMessage: (props: Parameters<typeof actual.AssistantMessage>[0]) => {
      renders.count++;
      return actual.AssistantMessage(props);
    },
  };
});

let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
  renders.count = 0;
});

const conversation = [
  msg("user", "一つ目の質問", { id: "u1" }),
  msg("assistant", "一つ目の答え", { id: "a1" }),
  msg("user", "二つ目の質問", { id: "u2" }),
  msg("assistant", "二つ目の答え", { id: "a2" }),
];

describe("吹き出しを描き直さない", () => {
  it("⚙パネルを開いて値を変え、閉じても、吹き出しは描き直さない", async () => {
    const { user } = renderChat({ conversationId: "c1", initialMessages: conversation });
    expect(await screen.findByText("二つ目の答え")).toBeInTheDocument();
    // 初回の描画（段階的な描画を含む）が落ち着いてから数え始める
    await waitFor(() => expect(renders.count).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    renders.count = 0;

    await user.click(screen.getByRole("button", { name: "生成パラメータ" }));
    await user.click(
      await screen.findByRole("button", { name: "Temperatureを手動設定" }),
    );
    // 値が本当に変わったこと（変わっていなければ描き直さないのは当然）
    expect(
      screen.getByRole("button", { name: "Temperatureを自動に戻す" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("変更あり")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Temperatureを自動に戻す" }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByText("この会話にのみ適用されます")).toBeNull();

    expect(renders.count).toBe(0);
    // 一覧が消えたから数が 0 なのではないこと
    expect(screen.getByText("一つ目の答え")).toBeInTheDocument();
    expect(screen.getByText("二つ目の答え")).toBeInTheDocument();
  });

  it("入力欄に打っても、吹き出しは描き直さない", async () => {
    const { user } = renderChat({ conversationId: "c1", initialMessages: conversation });
    expect(await screen.findByText("二つ目の答え")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    renders.count = 0;

    await user.type(screen.getByRole("textbox"), "つづき");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("つづき");

    expect(renders.count).toBe(0);
    expect(screen.getByText("二つ目の答え")).toBeInTheDocument();
  });
});

describe("描き直さなくても、操作は最新の状態で動く", () => {
  it("⚙で変えた値は、吹き出しの「再生成」にも効く", async () => {
    // 一覧は ⚙の変更では描き直されない。吹き出しの「再生成」が
    // 描いた時点の関数を握ったままだと、変える前の値で投げ直す
    server.on("/generate", () => new Promise<never>(() => {}));
    const { user } = renderChat({ conversationId: "c1", initialMessages: conversation });
    expect(await screen.findByText("二つ目の答え")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "生成パラメータ" }));
    await user.click(
      await screen.findByRole("button", { name: "Temperatureを手動設定" }),
    );
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "再生成" }));
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    const body = server.lastBody("/generate") as { params?: Record<string, unknown> };
    expect(body.params).toEqual({ temperature: 1 });
  });

  /**
   * 吹き出しが描画中に呼ぶ判定（画像の生成中か）は、元の値が変われば
   * 描き直しを起こさないといけない。「同一性を保つ」包みを同じように
   * かぶせると、選んでいるモデルを変えても見た目が古いまま残る。
   *
   * modelId を持たない古い行だけが、いま選んでいるモデルで判断される
   * （生成中の切り替えで見た目が変わらないことは chat-send が見ている）。
   */
  it("描画中に使う判定は、モデルを変えると吹き出しに届く", async () => {
    const IMAGE_MODEL = {
      ...TEST_MODEL,
      id: "test/image-model",
      name: "画像を出すモデル",
      outputModalities: ["image"],
    } as ModelInfo;
    const streaming = [
      msg("user", "猫の絵を描いて", { id: "u1" }),
      msg("assistant", "", { id: "a1", status: "streaming" }),
    ];
    server = installServer(streaming);
    const { user } = renderChat({
      conversationId: "c1",
      initialMessages: streaming,
      models: [TEST_MODEL, IMAGE_MODEL],
      initialModel: TEST_MODEL.id,
    });
    expect(await screen.findByText("猫の絵を描いて")).toBeInTheDocument();
    expect(screen.queryByText(/画像を生成中/)).toBeNull();

    await user.click(
      await screen.findByRole("button", { name: new RegExp(TEST_MODEL.name) }),
    );
    const picked = await screen.findAllByRole("button", {
      name: /画像を出すモデル/,
    });
    await user.click(picked[picked.length - 1]);

    expect(await screen.findByText(/画像を生成中/)).toBeInTheDocument();
  });
});
