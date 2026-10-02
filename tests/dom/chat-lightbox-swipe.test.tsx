import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { installServer, msg, renderChat } from "./helpers/chat-harness";

/**
 * 会話の中で開いた拡大表示から、左右に払って隣の画像へ移る。
 *
 * 並びは画面に描かれた順（上から）。添付と本文の中の画像は別々の入口
 * から開くので、片方だけを並べると、払った先で残りの画像が飛ばされる。
 */
beforeEach(() => {
  installServer();
  localStorage.clear();
});

/** いま拡大表示の中央に出ている画像。 */
function openedSrc(): string | null {
  return (
    screen.queryByAltText("添付画像")?.getAttribute("src") ?? null
  );
}

/** 拡大表示の上を払う。dx が負なら左へ（＝次へ）。 */
function swipe(dx: number) {
  const overlay = screen.getByLabelText("閉じる").parentElement!;
  fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 200 + dx / 2, clientY: 200 });
  fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 200 + dx, clientY: 200 });
  fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 200 + dx, clientY: 200 });
}

const thread = () =>
  renderChat({
    initialMessages: [
      msg("user", "この画像で", {
        id: "u1",
        attachments: [
          { id: "att-1", mimeType: "image/png", name: "元.png", size: 100 },
        ],
      }),
      msg(
        "assistant",
        // コードブロックの中は画像にならない——並びにも入れない
        "![一枚目](/api/files/gen-1)\n\n```\n![コード](/api/files/in-code)\n```\n\n![二枚目](/api/files/gen-2)",
        { id: "a1" },
      ),
      msg("user", "もう一枚", {
        id: "u2",
        attachments: [
          { id: "att-2", mimeType: "image/png", name: "後.png", size: 100 },
        ],
      }),
      msg("assistant", "了解です", { id: "a2" }),
    ],
  });

describe("会話の拡大表示を左右に払う", () => {
  it("添付と本文の画像を、上から順にたどる", async () => {
    const { user } = thread();
    await user.click(await screen.findByAltText("一枚目"));
    expect(openedSrc()).toBe("/api/files/gen-1");

    swipe(-120);
    // 同じメッセージの中の次の画像（コードブロックの中は飛ばす）
    expect(openedSrc()).toBe("/api/files/gen-2");
    swipe(-120);
    // メッセージをまたいで、後ろの添付へ
    expect(openedSrc()).toBe("/api/files/att-2");

    swipe(120);
    swipe(120);
    expect(openedSrc()).toBe("/api/files/gen-1");
    swipe(120);
    // 本文より上の添付へ戻れる
    expect(openedSrc()).toBe("/api/files/att-1");
    // 先頭では移らない
    swipe(120);
    expect(openedSrc()).toBe("/api/files/att-1");
  });

  it("端では移らず、拡大表示も開いたまま", async () => {
    const { user } = thread();
    await user.click(await screen.findByAltText("後.png"));
    expect(openedSrc()).toBe("/api/files/att-2");

    swipe(-120);
    expect(openedSrc()).toBe("/api/files/att-2");
    // 閉じたのではない（払いがタップとして閉じに化けていない）
    expect(screen.getByLabelText("閉じる")).toBeTruthy();

    swipe(120);
    expect(openedSrc()).toBe("/api/files/gen-2");
  });

  it("隣の画像が、払う前から横のマスに置かれている", async () => {
    const { user } = thread();
    await user.click(await screen.findByAltText("二枚目"));
    const overlay = screen.getByLabelText("閉じる").parentElement!;
    const neighbours = [...overlay.querySelectorAll('img[alt=""]')].map((img) =>
      img.getAttribute("src"),
    );
    expect(neighbours).toEqual(["/api/files/gen-1", "/api/files/att-2"]);
  });

  it("同じ画像が2箇所にあっても、同じ絵を2度は出さない", async () => {
    const { user } = renderChat({
      initialMessages: [
        msg("user", "猫を", { id: "u1" }),
        msg("assistant", "![猫](/api/files/gen-1)", { id: "a1" }),
        msg("user", "これを直して", {
          id: "u2",
          attachments: [
            { id: "gen-1", mimeType: "image/png", name: "猫.png", size: 100 },
          ],
        }),
        msg("assistant", "![直した猫](/api/files/gen-2)", { id: "a2" }),
      ],
    });
    await user.click(await screen.findByAltText("猫"));
    swipe(-120);
    expect(openedSrc()).toBe("/api/files/gen-2");
  });
});
