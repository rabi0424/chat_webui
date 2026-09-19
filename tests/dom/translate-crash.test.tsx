/**
 * 生成中に Safari の画面翻訳を使ったとき、画面が丸ごとエラーに
 * 差し替わらないか（§3.3）。
 *
 * 画面翻訳は、訳した文を**元の節点と差し替える**形で入れてくる。
 * 一方こちらは生成中、届いた語を `<span class="stream-token">` に包んで
 * 出し、その塊が伸び終わると包みを外して描き直す。**React は自分が
 * 置いたはずの節点を消しに行き、それが既に翻訳へ差し替えられていると
 * `NotFoundError` で落ちる**——受け皿はルートにしか無いので、本文どころか
 * 画面ごと「読み込めませんでした」に差し替わる（利用者からは、英文の
 * 生成中に翻訳を掛けるとエラー画面になる、という形で出た）。
 *
 * ここでは画面翻訳のまねをして、そのあと React に描き直させる。
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { StreamingMessage } from "../../app/components/StreamingMessage";
import { installServer, renderChat } from "./helpers/chat-harness";

/** 中身が文字だけ（＝訳す単位になる）要素か。 */
const INLINE = new Set([
  "SPAN",
  "EM",
  "STRONG",
  "A",
  "CODE",
  "B",
  "I",
  "FONT",
  "SUP",
  "SUB",
  "DEL",
  "BR",
]);

function isLeafBlock(el: Element): boolean {
  if (el.childNodes.length === 0) return false;
  return [...el.childNodes].every(
    (n) =>
      n.nodeType === Node.TEXT_NODE ||
      (n.nodeType === Node.ELEMENT_NODE && INLINE.has((n as Element).tagName)),
  );
}

/**
 * ブラウザの画面翻訳のまね。
 *
 * 訳した文を1つの節点にまとめて差し替える（Chrome は `<font>` を挟み、
 * Safari も同様に元の節点を置き換える）。**元々そこにあった
 * `<span class="stream-token">` は DOM から外れる**ので、React が
 * あとからそれを消そうとすると落ちる。
 *
 * @param rude `translate="no"` を無視するか（翻訳の実装によっては
 *   断っても触ってくる。受け皿が効くかを見るのに使う）
 * @returns 訳した箇所の数。0 なら、この検査は何も試していない
 */
function translatePage(root: ParentNode, { rude = false } = {}): number {
  let count = 0;
  for (const el of root.querySelectorAll("*")) {
    if (!rude && el.closest('[translate="no"]')) continue;
    if (!isLeafBlock(el)) continue;
    const text = el.textContent ?? "";
    if (!text.trim()) continue;
    const font = document.createElement("font");
    font.textContent = `【訳】${text}`;
    el.replaceChildren(font);
    count += 1;
  }
  return count;
}

/** 段落が2つ。前の段落は確定ぶん、後ろは流入中の末尾になる。 */
const TEXT = `The first paragraph is already settled.

The second paragraph is still arriving.`;

describe("生成中の画面翻訳", () => {
  it("訳されたあとに生成が終わっても、描き直しで落ちない", () => {
    const { container, rerender } = render(
      <StreamingMessage text={TEXT} streaming />,
    );

    // 訳す対象が本当にあったことを先に確かめる（0件なら、このあとの
    // 「落ちない」は何も試していない）
    expect(translatePage(container)).toBeGreaterThan(0);

    // 生成の終わり。語の包み（stream-token）が外れ、React は自分が
    // 置いた節点を消しに行く
    expect(() =>
      rerender(<StreamingMessage text={TEXT} streaming={false} />),
    ).not.toThrow();
  });

  it("伸びている途中の塊は翻訳の対象外、確定した塊は対象", () => {
    const { container } = render(<StreamingMessage text={TEXT} streaming />);
    const paragraphs = [...container.querySelectorAll("p")];
    expect(paragraphs).toHaveLength(2);
    // 確定ぶんは訳してよい（断っていない）
    expect(paragraphs[0].getAttribute("translate")).toBeNull();
    // 伸びている末尾だけを断る
    expect(paragraphs[1].getAttribute("translate")).toBe("no");
  });

  it("生成が終われば、末尾の塊も翻訳の対象に戻る", () => {
    const { container, rerender } = render(
      <StreamingMessage text={TEXT} streaming />,
    );
    rerender(<StreamingMessage text={TEXT} streaming={false} />);
    for (const p of container.querySelectorAll("p")) {
      expect(p.getAttribute("translate")).toBeNull();
    }
    // 断りが外れただけで、本文はそのまま出ている
    expect(screen.getByText(/still arriving/)).toBeTruthy();
  });
});

/**
 * 断りを無視する翻訳（そういう実装もあり得るし、訳し終えた本文を
 * あとから描き直す操作——枝の切り替えや編集のやり直し——でも同じ
 * 衝突が起きる）。そのときに画面ごと失わないかを見る。
 *
 * これは受け皿（MessageBoundary）が一覧に配線されているかの見張りでも
 * ある。受け皿の作りそのものは tests/dom/message-boundary.test.tsx。
 */
describe("断りを無視して訳されたとき", () => {
  beforeEach(() => {
    localStorage.clear();
    // 受け皿が拾った失敗は React が console へ出す（出ること自体は仕様）
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("その1件を作り直して、本文の続きを出し続ける", async () => {
    const server = installServer();
    server.on("/generate", () => ({
      userMessageId: "u1",
      assistantMessageId: "a1",
    }));
    /*
      訳されたあとに**生成が終わる**ところまで運ぶ。伸びているあいだは
      語の包み（stream-token）を足していくだけなので、訳された節点とは
      すれ違わない。包みを外す＝節点を消しに行くのは、終わった瞬間。
    */
    let finished = false;
    const current = () =>
      finished ? `${TEXT} Third sentence has arrived.` : TEXT;
    server.on("/path", () => ({
      messages: [
        { id: "u1", role: "user", content: "質問", createdAt: 1 },
        { id: "a1", role: "assistant", content: current(), createdAt: 2 },
      ],
    }));
    server.on("/messages/", () => ({
      content: current(),
      reasoning: null,
      status: finished ? "done" : "streaming",
      error: null,
      usage: null,
      citations: null,
    }));

    const view = renderChat({});
    await view.user.type(await screen.findByRole("textbox"), "質問");
    await view.user.keyboard("{Enter}");

    const feed = () => view.container.querySelector(".chat-text") as HTMLElement;
    await waitFor(() => expect(feed().textContent).toContain("still arriving"), {
      timeout: 5000,
    });

    // 断りごと無視して、やり取りの中身を全部訳す
    expect(translatePage(feed(), { rude: true })).toBeGreaterThan(0);
    expect(feed().textContent).toContain("【訳】");

    finished = true;
    // 生成の終わりで、訳された節点をこちらが消しに行く。受け皿が無いと、
    // ここで画面（Chat ごと）が消える
    await waitFor(
      () => expect(view.container.textContent).toContain("Third sentence"),
      { timeout: 5000 },
    );
    // 入力欄も残っている（画面が丸ごと差し替わっていない）
    expect(screen.getByRole("textbox")).toBeTruthy();
  }, 20_000);
});
