import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccentPicker, ThemeToggle } from "../../app/components/ThemeToggle";
import { getTheme, saveTheme, THEME_STORAGE_KEY } from "../../app/lib/theme";
import { getAccent, saveAccent } from "../../app/lib/accent";
import {
  getChatFontSize,
  saveChatFontSize,
} from "../../app/lib/chat-font";
import { readRaw } from "../../app/lib/persisted";

/**
 * 端末ごとの見た目の設定。
 *
 * 同じ値を見ている場所が2つ以上ある（サイドバーのトグルと設定画面）。
 * 別々に state を持っていたころは、片方で変えてももう片方は古い値の
 * ままで、次に押すと一手ずれていた。
 */
beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  delete document.documentElement.dataset.accent;
});

describe("テーマ", () => {
  it("押すたびに ライト → ダーク → 自動 と巡る", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const button = () => screen.getByRole("button");

    // 既定は「自動」
    expect(button().getAttribute("aria-label")).toContain("自動");
    await user.click(button());
    expect(button().getAttribute("aria-label")).toContain("ライト");
    await user.click(button());
    expect(button().getAttribute("aria-label")).toContain("ダーク");
    await user.click(button());
    expect(button().getAttribute("aria-label")).toContain("自動");
  });

  it("保存値から始まる", () => {
    saveTheme("dark");
    render(<ThemeToggle />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain(
      "ダーク",
    );
  });

  /** これが直したかった症状。 */
  it("別の場所で変えた分がすぐ映る", async () => {
    render(<ThemeToggle />);
    const button = () => screen.getByRole("button");
    expect(button().getAttribute("aria-label")).toContain("自動");

    // 設定画面で変えた、に相当する（Reactの外からの変更）
    act(() => saveTheme("light"));
    expect(button().getAttribute("aria-label")).toContain("ライト");

    // 続けて押したら、その次（ダーク）へ進む。一手ずれない
    await user_click(button());
    expect(button().getAttribute("aria-label")).toContain("ダーク");
  });

  it("押すとDOMと保存の両方が変わる", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button")); // → ライト
    await user.click(screen.getByRole("button")); // → ダーク
    expect(readRaw(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(getTheme()).toBe("dark");
  });
});

describe("アクセント色", () => {
  it("選ぶと保存され、DOMにも乗る", async () => {
    const user = userEvent.setup();
    render(<AccentPicker />);
    await user.click(screen.getByRole("radio", { name: "グリーン" }));
    expect(getAccent()).toBe("green");
    expect(document.documentElement.dataset.accent).toBe("green");
  });

  /** 印は1つだけ付く。押した色に移らないと、どれが効いているのか読めない。 */
  it("別の場所で変えた分がすぐ映る", () => {
    render(<AccentPicker />);
    act(() => saveAccent("pink"));
    const checked = screen
      .getAllByRole("radio")
      .filter((b) => b.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0].getAttribute("aria-label")).toBe("ピンク");
  });
});

describe("壊れた保存値", () => {
  it("知らないテーマ名は「自動」に落とす", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    expect(getTheme()).toBe("system");
  });

  it("知らないアクセント名は既定に落とす", () => {
    localStorage.setItem("chat-webui:accent", "chartreuse");
    render(<AccentPicker />);
    expect(getAccent()).toBe("blue");
  });

  it("知らない文字サイズは標準に落とす", () => {
    localStorage.setItem("chat-webui:chat-font", "gigantic");
    expect(getChatFontSize()).toBe("m");
  });

  it("文字サイズは保存されて CSS 変数に乗る", () => {
    saveChatFontSize("xl");
    expect(getChatFontSize()).toBe("xl");
    expect(
      document.documentElement.style.getPropertyValue("--chat-font-scale"),
    ).not.toBe("");
  });
});

/** userEvent を毎回 setup すると重いので、単発クリック用の薄い包み。 */
async function user_click(el: HTMLElement) {
  await userEvent.setup().click(el);
}
