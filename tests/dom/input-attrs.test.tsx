import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";
import { BotForm } from "../../app/components/BotForm";
import { installServer, msg, renderChat } from "./helpers/chat-harness";
import { installSidebarServer, renderSidebar } from "./helpers/sidebar-harness";
import { TEST_MODEL } from "./helpers/chat-harness";

/**
 * 文字入力欄の属性が、実際に描かれた要素まで届いているか（監査 F-21）。
 *
 * ソースに {...TERSE_INPUT} と書いてあることは tests/input-attrs.test.ts で
 * 見ている。こちらは「書いた属性が要素に載っているか」——JSX の spread は
 * 後ろの属性に上書きされるので、className の並び順を変えただけで
 * 静かに効かなくなりうる。
 */

/** いま画面にある、文字を打つ欄。 */
function textEntries(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      'textarea, input[type="text"], input[type="search"]',
    ),
  ];
}

function expectAttributes(el: HTMLElement, kind: "prose" | "terse"): void {
  const where = `${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? ""}]`;
  expect(`${where}: ${el.getAttribute("autocomplete")}`).toBe(`${where}: off`);
  expect(`${where}: ${el.getAttribute("autocapitalize")}`).toBe(
    `${where}: ${kind === "prose" ? "sentences" : "none"}`,
  );
  expect(`${where}: ${el.getAttribute("spellcheck")}`).toBe(
    `${where}: ${kind === "prose" ? "true" : "false"}`,
  );
}

describe("描かれた入力欄の属性", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("本文の入力欄（文章として扱う）", () => {
    installServer();
    renderChat({});
    const boxes = textEntries();
    expect(boxes).toHaveLength(1);
    expectAttributes(boxes[0], "prose");
  });

  it("編集の入力欄（文章として扱う）", async () => {
    const conversation = [
      msg("user", "最初の質問", { id: "u1" }),
      msg("assistant", "最初の応答", { id: "a1" }),
    ];
    installServer(conversation);
    const { user } = renderChat({ initialMessages: conversation });
    await user.click((await screen.findAllByLabelText("編集して再送信"))[0]);

    const editor = await screen.findByDisplayValue("最初の質問");
    expectAttributes(editor, "prose");
  });

  it("会話の検索（短い語句として扱う）", async () => {
    installSidebarServer();
    const { user } = renderSidebar({});
    // 検索は押したときだけ入力欄に変わる
    await user.click(screen.getByLabelText("会話を検索"));
    expectAttributes(screen.getByLabelText("会話を検索"), "terse");
  });

  it("ボットの編集（名前は語句、システムプロンプトは文章）", () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <ConfirmProvider>
            <BotForm models={[TEST_MODEL]} retryCeiling={5} newModelDays={7} />
          </ConfirmProvider>
        ),
      },
    ]);
    render(<Stub initialEntries={["/"]} />);

    expectAttributes(screen.getByLabelText("名前"), "terse");
    expectAttributes(screen.getByLabelText("アイコン（絵文字）"), "terse");
    expectAttributes(screen.getByLabelText("システムプロンプト"), "prose");
  });
});
