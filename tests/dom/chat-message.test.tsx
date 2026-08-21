import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { installServer, msg, renderChat, type ServerStub } from "./helpers/chat-harness";

/**
 * 吹き出しそのものの見せ方。
 *
 * 「末尾かどうか」と「生成中かどうか」で出し分けが変わる。どちらも
 * 一覧の外（Chat 本体）から渡される値なので、渡し忘れても型は通り、
 * 画面だけが静かに変わる。ここで押さえる。
 */
let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

describe("末尾のメッセージ", () => {
  it("失敗の再試行は、最後の1件にだけ出る", () => {
    renderChat({
      initialMessages: [
        msg("user", "1回目の質問", { id: "u1" }),
        msg("assistant", "", {
          id: "a1",
          status: "error",
          error: "前に失敗したほう",
        }),
        msg("user", "2回目の質問", { id: "u2" }),
        msg("assistant", "", {
          id: "a2",
          status: "error",
          error: "最後に失敗したほう",
        }),
      ],
    });
    // どちらの失敗も本文は出る
    expect(screen.getByText("前に失敗したほう")).toBeTruthy();
    expect(screen.getByText("最後に失敗したほう")).toBeTruthy();
    // やり直せるのは最後の1件だけ
    expect(screen.getAllByRole("button", { name: "再試行" })).toHaveLength(1);
  });
});

describe("生成中の吹き出し", () => {
  /** /generate を宙吊りにして、生成中のまま止める。 */
  function hangGeneration() {
    server.on("/generate", () => new Promise<never>(() => {}));
  }

  it("生成中は、編集・分岐・削除の入口を出さない", async () => {
    const { user } = renderChat({
      initialMessages: [
        msg("user", "前の質問", { id: "u1" }),
        msg("assistant", "前の答え", { id: "a1" }),
      ],
    });
    // 生成していないあいだは出ている
    expect(screen.getAllByLabelText("編集して再送信").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("削除").length).toBeGreaterThan(0);

    hangGeneration();
    await user.click(screen.getByRole("button", { name: "↻ 再生成" }));

    // 木が動いている最中なので、木を変える操作は伏せる
    await waitFor(() =>
      expect(screen.queryByLabelText("編集して再送信")).toBeNull(),
    );
    expect(screen.queryByLabelText("削除")).toBeNull();
    expect(screen.queryByTitle(/ここから分岐/)).toBeNull();
  });
});

describe("一覧の末尾に出る誘い", () => {
  it("最後がユーザーの発言なら、応答を生成できる", async () => {
    const { user } = renderChat({
      initialMessages: [msg("user", "分岐した先の質問", { id: "u1" })],
    });
    await user.click(screen.getByRole("button", { name: "↵ 応答を生成" }));
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
  });

  it("生成そのものが失敗したら、帯を出してやり直せる", async () => {
    const { user } = renderChat({
      initialMessages: [
        msg("user", "前の質問", { id: "u1" }),
        msg("assistant", "前の答え", { id: "a1" }),
      ],
    });
    server.fail("/generate", 500);
    await user.click(screen.getByRole("button", { name: "↻ 再生成" }));

    const retry = await screen.findByRole("button", { name: "再試行" });
    expect(server.countOf("/generate")).toBe(1);

    // 帯の「再試行」からもう一度投げられる
    await user.click(retry);
    await waitFor(() => expect(server.countOf("/generate")).toBe(2));
  });
});

describe("長い会話", () => {
  /**
   * 初回描画は末尾だけにして、出てから全件に広げる（DEFERRED_TAIL）。
   * 広げ損ねると、古い発言が二度と出てこない。
   */
  it("先頭の発言も、広がったあとには出ている", async () => {
    const many = Array.from({ length: 60 }, (_, n) =>
      msg(n % 2 === 0 ? "user" : "assistant", `${n}番目の発言`, { id: `m${n}` }),
    );
    renderChat({ initialMessages: many });
    expect(await screen.findByText("0番目の発言")).toBeTruthy();
    expect(screen.getByText("59番目の発言")).toBeTruthy();
  });
});

describe("Escape で閉じる", () => {
  it("削除の選択モードから抜けられる", async () => {
    const { user } = renderChat({
      initialMessages: [
        msg("user", "前の質問", { id: "u1" }),
        msg("assistant", "前の答え", { id: "a1" }),
      ],
    });
    await user.click(screen.getAllByLabelText("削除")[0]);
    expect(document.body.textContent).toContain("選択中");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.body.textContent).not.toContain("選択中"),
    );
    // 入力欄が戻る
    expect(screen.getByLabelText("送信")).toBeTruthy();
  });
})

/**
 * 添付画像。
 *
 * 大きさが分かるのは読み込みが終わってからで、それまで枠はほぼ高さを
 * 持たない。あとから高さが増えるぶん下の内容が押し下がり、最下部に
 * 居たはずが少し上に取り残される。
 */
describe("添付画像", () => {
  const withImage = () =>
    renderChat({
      initialMessages: [
        msg("user", "この画像です", {
          id: "u1",
          attachments: [
            { id: "att-1", mimeType: "image/png", name: "ねこ.png", size: 100 },
          ],
        }),
      ],
    });

  it("読み込み前から場所を取っておく", () => {
    const { container } = withImage();
    const box = container.querySelector('button[title="ねこ.png"]');
    expect(box).toBeTruthy();
    // 高さゼロから一気に伸びると、下の内容が押し下がって読み位置が跳ぶ
    expect(box?.className).toMatch(/min-h-/);
    expect(box?.className).toMatch(/min-w-/);
  });

  it("読み込みが終わったら、最下部への追従をやり直す", async () => {
    const { container } = withImage();
    const img = container.querySelector(
      'img[alt="ねこ.png"]',
    ) as HTMLImageElement;
    expect(img).toBeTruthy();

    // 追従は scrollTop を最下部へ動かす形で行う。jsdom では
    // 高さが常に0なので、伸びた状態を用意してから確かめる
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", {
      value: 5000,
      configurable: true,
    });
    scroller.scrollTop = 0;

    fireEvent.load(img);
    expect(scroller.scrollTop).toBe(5000);
  });
});
