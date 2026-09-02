import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  answerDialog,
  installServer,
  msg,
  renderChat,
  type ServerStub,
} from "./helpers/chat-harness";

/**
 * 削除。ゴミ箱を押すと選択モードに入り、選んだものをまとめて消す。
 * 消したあとの並びはサーバーが返したものを正とする。
 */
let server: ServerStub;
const conversation = () => [
  msg("user", "質問1", { id: "u1" }),
  msg("assistant", "応答1", { id: "a1" }),
  msg("user", "質問2", { id: "u2" }),
  msg("assistant", "応答2", { id: "a2" }),
];

beforeEach(() => {
  server = installServer(conversation());
  localStorage.clear();
});

const deleteButton = () =>
  screen.getAllByRole("button", { name: "削除" }).filter(
    (b) => b.textContent?.trim() === "削除",
  )[0];

describe("削除", () => {
  it("ゴミ箱を押すと選択モードに入り、その1件が選ばれる", async () => {
    const { user } = renderChat({ initialMessages: conversation() });
    await user.click((await screen.findAllByLabelText("削除"))[0]);
    expect(await screen.findByText(/1件選択中/)).toBeTruthy();
  });

  it("選んだIDをサーバーへ渡し、返った並びに置き換える", async () => {
    const { user } = renderChat({ initialMessages: conversation() });
    await user.click((await screen.findAllByLabelText("削除"))[0]);
    await screen.findByText(/1件選択中/);
    await user.click(deleteButton());
    // 確認が出るまでは送らない
    expect(server.calls.some((c) => c.path.includes("/delete-messages"))).toBe(false);
    await answerDialog(user, true);

    await waitFor(() => {
      const body = server.lastBody("/delete-messages") as { ids: string[] };
      expect(body.ids).toEqual(["u1"]);
    });
    // サーバーが返した並び（u1 が消えたもの）になる
    await waitFor(() => expect(screen.queryByText("質問1")).toBeNull());
    expect(screen.getByText("応答1")).toBeTruthy();
  });

  it("キャンセルすると何も消えない", async () => {
    const { user } = renderChat({ initialMessages: conversation() });
    await user.click((await screen.findAllByLabelText("削除"))[0]);
    await screen.findByText(/1件選択中/);
    await user.click(screen.getByRole("button", { name: "キャンセル" }));

    await waitFor(() => expect(screen.queryByText(/件選択中/)).toBeNull());
    expect(server.calls.some((c) => c.path.includes("/delete-messages"))).toBe(false);
    expect(screen.getByText("質問1")).toBeTruthy();
  });

  it("確認でやめたら消えない", async () => {
    const { user } = renderChat({ initialMessages: conversation() });
    await user.click((await screen.findAllByLabelText("削除"))[0]);
    await screen.findByText(/1件選択中/);
    await user.click(deleteButton());
    await answerDialog(user, false);
    await waitFor(() =>
      expect(server.calls.some((c) => c.path.includes("/delete-messages"))).toBe(
        false,
      ),
    );
    expect(screen.getByText("質問1")).toBeTruthy();
  });

  it("選択モードでタップして選び足せる", async () => {
    const { user } = renderChat({ initialMessages: conversation() });
    await user.click((await screen.findAllByLabelText("削除"))[0]);
    await screen.findByText(/1件選択中/);
    // 別のメッセージをタップして選択に加える
    await user.click(screen.getByText("応答1"));
    expect(await screen.findByText(/2件選択中/)).toBeTruthy();

    await user.click(deleteButton());
    await answerDialog(user, true);
    await waitFor(() => {
      const body = server.lastBody("/delete-messages") as { ids: string[] };
      expect(new Set(body.ids)).toEqual(new Set(["u1", "a1"]));
    });
  });
});

/**
 * 選択モード中の画像。
 *
 * 行を選ぶつもりのタップで拡大表示まで開き、閉じたときには行も選ばれて
 * いた（タップが二重に効く）。選択モード中は拡大の入口を渡さない
 * ——本文の画像はただの画像に戻る（監査 C-8）。
 */
describe("選択モード中の画像", () => {
  const withImage = () => [
    msg("user", "質問1", { id: "u1" }),
    msg("assistant", "図です\n\n![図](/api/files/att-1)", { id: "a1" }),
  ];

  it("選択モードでは、本文の画像が拡大の押しどころにならない", async () => {
    server = installServer(withImage());
    const { user } = renderChat({ initialMessages: withImage() });
    // ふだんは押せる（ここが出ていないと、次の確認が空振りする）
    expect(await screen.findByTitle("タップで拡大")).toBeTruthy();

    await user.click((await screen.findAllByLabelText("削除"))[0]);
    await screen.findByText(/1件選択中/);

    expect(screen.queryByTitle("タップで拡大")).toBeNull();
    // 画像そのものは出したまま（消えたり畳まれたりはしない）
    expect(screen.getByAltText("図")).toBeTruthy();
  });
});
