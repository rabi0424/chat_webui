import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StreamingMessage } from "../../app/components/StreamingMessage";
import { installServer, msg, renderChat } from "./helpers/chat-harness";

/**
 * 応答の描き直し（監査 E-7）。
 *
 * 以前は「確定ぶん」と「流入中の末尾」を別の入れ物で描き、生成が
 * 終わったところで全文をひとつの Markdown に差し替えていた。さらに
 * 末尾のメッセージだけ StreamingMessage、それ以外は Markdown という
 * 使い分けもあった。**要素の並びや型が変わると React はそこを作り直す**
 * ので、出来上がっていた図は fallback に戻り、利用者が並べ替えた表は
 * 元の順に戻っていた。
 *
 * ここで見るのは「作り直していないこと」。画面には同じものが出るため、
 * 見た目だけでは壊れたことに気づけない——節点そのものを見る。
 */
const TEXT = `本文の段落です。

| 名前 | 数 |
|---|---|
| い | 2 |
| あ | 1 |
`;

/** いま出ている表の節点。作り直されると別物になる。 */
const table = () => document.querySelector("table");

/** 表の中身を上から並べる。 */
const rows = () =>
  [...document.querySelectorAll("tbody tr")].map((r) => r.textContent);

describe("生成が終わったとき", () => {
  it("同じ節点のまま残る（作り直さない）", () => {
    const { rerender } = render(<StreamingMessage text={TEXT} streaming />);
    const before = table();
    expect(before).toBeTruthy();

    rerender(<StreamingMessage text={TEXT} streaming={false} />);
    expect(table()).toBe(before);
    expect(before?.isConnected).toBe(true);
  });

  /**
   * 作り直しの、利用者から見える形。表の並べ替えはコンポーネントの
   * 状態なので、作り直されると黙って元の順に戻る。
   */
  it("並べ替えた表が、元の順に戻らない", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<StreamingMessage text={TEXT} streaming />);

    await user.click(document.querySelectorAll("th")[0] as HTMLElement);
    const sorted = rows();
    // 並べ替えが効いていること自体を先に確かめる（効いていなければ、
    // このあとの「変わっていない」は何も検査していないことになる）
    expect(sorted).toEqual(["あ1", "い2"]);

    rerender(<StreamingMessage text={TEXT} streaming={false} />);
    expect(rows()).toEqual(sorted);
  });

  /**
   * 図は「書き終わってから」描く。書きかけの mermaid を描こうとすると
   * 途中の構文で失敗し続けるので、生成中は黙って待つ作りになっている。
   * 塊へ渡す streaming がここを決めるので、渡し忘れると生成中ずっと
   * 描こうとする。
   */
  it("生成中は図にせず、終わってから描きにいく", async () => {
    const DIAGRAM = "```mermaid\ngraph TD;A-->B;\n```\n";
    /*
     * 図として決着がついた印。描きにいって失敗すると理由が添えられる
     * （jsdom には mermaid が要る描画環境が無いので、ここでは必ず失敗
     * する）。生成中は「書きかけなのが普通」として黙って待つので、
     * この一文は出ない——出るかどうかが、渡した streaming の答えになる。
     */
    const settled = () =>
      document.body.textContent?.includes("図として解釈できませんでした") === true;

    const { rerender } = render(<StreamingMessage text={DIAGRAM} streaming />);
    // ソースのまま出ている（描きかけを描こうとしていない）
    expect(document.body.textContent).toContain("graph TD");
    await new Promise((r) => setTimeout(r, 400));
    expect(settled()).toBe(false);

    rerender(<StreamingMessage text={DIAGRAM} streaming={false} />);
    // 描きにいった結果が出る（図になるか、ならない理由が添えられる）
    await waitFor(() => expect(settled()).toBe(true), { timeout: 4000 });
  }, 10000);

  /**
   * 語ごとのフェードは、いま伸びている塊にだけ付ける。すべての塊に
   * 付けると、既に出ている本文まで <span> に包み直されて作り直しになる
   * （その塊の中の状態が飛ぶ）。
   */
  it("ふわりと出すのは、伸びている末尾の塊だけ", () => {
    const LONG = `最初の段落です。

二つ目の段落です。

三つ目の段落が伸びています。`;
    const { container } = render(<StreamingMessage text={LONG} streaming />);
    const bodies = [...container.querySelectorAll(".prose > *")];
    expect(bodies.length).toBeGreaterThan(1);

    const animated = bodies.map(
      (b) => b.querySelectorAll(".stream-token").length > 0,
    );
    // 最後のひとつだけ true
    expect(animated).toEqual([
      ...animated.slice(0, -1).map(() => false),
      true,
    ]);
    expect(animated.filter(Boolean)).toHaveLength(1);
  });
});

describe("次の発言が来て、末尾でなくなったとき", () => {
  /**
   * 末尾かどうかで描き手が変わると、次の発言を送った瞬間に作り直される。
   * onReveal（最下部への追従）は末尾のときだけ渡すが、それは props の
   * 違いにすぎず、要素の型は変わらない。
   */
  it("同じ節点のまま残る", () => {
    const { rerender } = render(
      <StreamingMessage text={TEXT} streaming={false} onReveal={() => {}} />,
    );
    const before = table();
    expect(before).toBeTruthy();

    // 末尾でなくなった＝追従は要らなくなった
    rerender(<StreamingMessage text={TEXT} streaming={false} />);
    expect(table()).toBe(before);
    expect(before?.isConnected).toBe(true);
  });
});

/**
 * ここまでは StreamingMessage を直に動かしている。AssistantMessage が
 * 末尾とそれ以外で描き手を変えていると、上のテストは通ったまま同じ
 * 症状が出る（作り直すのが、一段外側になるだけ）。会話ごと動かして
 * 見張る。
 */
describe("会話の中で、次の発言を送ったとき", () => {
  const conversation = () => [
    msg("user", "表をください", { id: "u1" }),
    msg("assistant", TEXT, { id: "a1" }),
  ];

  it("前の応答の表が、並べ替えたまま残る", async () => {
    installServer(conversation());
    const { user } = renderChat({ initialMessages: conversation() });

    await user.click((await screen.findAllByRole("columnheader"))[0]);
    expect(rows()).toEqual(["あ1", "い2"]);
    const before = table();

    await user.type(screen.getByRole("textbox"), "次の質問");
    await user.keyboard("{Enter}");
    // 次の応答が届いた＝前の応答は末尾でなくなった
    expect(await screen.findByText("応答です")).toBeTruthy();

    expect(table()).toBe(before);
    expect(rows()).toEqual(["あ1", "い2"]);
  }, 15000);
});
