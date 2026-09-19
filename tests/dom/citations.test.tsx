import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CitationList, ReasoningBlock } from "../../app/components/chat/message-parts";

/**
 * 出典と思考プロセスの見せ方（UI-5）。
 *
 * 出典は畳んだ状態ではホスト名のチップを3つまで横に並べ、残りは「+N」。
 * 開くと番号付きの一覧になる。数を変えても画面は静かに変わるだけなので、
 * 上限と「+N」の数え方をここで見る。
 */
const cite = (n: number) => ({
  url: `https://site${n}.example.com/path/${n}?q=x`,
  title: `記事${n}`,
});

describe("出典のチップ", () => {
  it("3つまではホスト名のチップで、残りは +N にまとめる", () => {
    render(<CitationList citations={[1, 2, 3, 4, 5].map(cite)} />);
    expect(screen.getByText("site1.example.com")).toBeTruthy();
    expect(screen.getByText("site3.example.com")).toBeTruthy();
    expect(screen.queryByText("site4.example.com")).toBeNull();
    expect(screen.getByRole("button", { name: /\+2/ })).toBeTruthy();
  });

  it("3つ以下なら +N ではなく「参照元」", () => {
    render(<CitationList citations={[1, 2].map(cite)} />);
    expect(screen.getByRole("button", { name: /参照元/ })).toBeTruthy();
    expect(screen.queryByText(/\+\d/)).toBeNull();
  });

  it("開くと全部が番号付きで並び、閉じられる", async () => {
    const user = userEvent.setup();
    render(<CitationList citations={[1, 2, 3, 4].map(cite)} />);
    await user.click(screen.getByRole("button", { name: /\+1/ }));
    expect(screen.getByText("記事4")).toBeTruthy();
    expect(screen.getByText("4.")).toBeTruthy();
    // チップは畳む（同じホストが二重に出ない）
    expect(screen.getAllByText("site1.example.com")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /参照元 4件/ }));
    expect(screen.queryByText("記事4")).toBeNull();
    expect(screen.getByRole("button", { name: /\+1/ })).toBeTruthy();
  });

  it("チップのファビコンはホスト名だけを送る", () => {
    render(<CitationList citations={[cite(1)]} />);
    const img = document.querySelector("img") as HTMLImageElement;
    expect(img.src).toContain("site1.example.com");
    expect(img.src).not.toContain("path");
    expect(img.src).not.toContain("q=");
  });
});

describe("思考プロセスのカード", () => {
  it("思考中は開いたまま「思考中…」と出る", () => {
    render(<ReasoningBlock reasoning="まず前提を確かめる" streaming />);
    expect(screen.getByText("思考中…")).toBeTruthy();
    expect(screen.getByText("まず前提を確かめる")).toBeTruthy();
  });

  it("終わったら畳まれていて、押すと開く", async () => {
    const user = userEvent.setup();
    render(<ReasoningBlock reasoning="まず前提を確かめる" streaming={false} />);
    expect(screen.queryByText("まず前提を確かめる")).toBeNull();
    // 「無いこと」だけを見ない: 畳まれているだけで、カードは出ている
    expect(screen.getByRole("button", { name: /思考プロセス/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /思考プロセス/ }));
    expect(screen.getByText("まず前提を確かめる")).toBeTruthy();
  });

  /*
   * 開け閉めの3つ。思考中に押しても閉じず、終わっても開いたままで、
   * どちらの向きにも効かない状態が続いていた。
   */
  it("思考中でも、押せば畳める", async () => {
    const user = userEvent.setup();
    render(<ReasoningBlock reasoning="まず前提を確かめる" streaming />);
    const button = screen.getByRole("button", { name: /思考中/ });
    await user.click(button);
    expect(screen.queryByText("まず前提を確かめる")).toBeNull();
    // 畳まれただけで、見出しは「思考中…」のまま出ている
    expect(screen.getByText("思考中…")).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // もう一度押せば開く
    await user.click(button);
    expect(screen.getByText("まず前提を確かめる")).toBeTruthy();
  });

  it("押していなければ、思考が終わった時点で畳まれる", () => {
    const { rerender } = render(
      <ReasoningBlock reasoning="まず前提を確かめる" streaming />,
    );
    expect(screen.getByText("まず前提を確かめる")).toBeTruthy();
    rerender(<ReasoningBlock reasoning="まず前提を確かめる" streaming={false} />);
    expect(screen.queryByText("まず前提を確かめる")).toBeNull();
    expect(screen.getByText("思考プロセス")).toBeTruthy();
  });

  it("思考中に開いたままにしていたら、終わっても畳まれない", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ReasoningBlock reasoning="まず前提を確かめる" streaming />,
    );
    const button = screen.getByRole("button", { name: /思考中/ });
    // 一度畳んでから開き直す＝「開いておく」と押して選んだ状態
    await user.click(button);
    await user.click(button);
    rerender(<ReasoningBlock reasoning="まず前提を確かめる" streaming={false} />);
    expect(screen.getByText("まず前提を確かめる")).toBeTruthy();
  });
});
