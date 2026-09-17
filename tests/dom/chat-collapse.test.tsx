import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { installServer, msg, renderChat, type ServerStub } from "./helpers/chat-harness";
import {
  COLLAPSED_BODY_PX,
  COLLAPSE_SLACK_PX,
} from "../../app/components/chat/message-parts";

/**
 * 長い本文の折り畳み。
 *
 * **見え方が変わるだけ**の機能なので、壊れ方も画面にしか出ない。
 * 「畳まれているのに本文が無い（消えている）」と「畳まれていない」は
 * どちらも黙って起きる。本文がそこに**在って**、隠れているだけ、まで
 * 見る。
 *
 * 高さは描いてから測る（字数ではない）。jsdom には配置が無く高さは
 * 常に 0 なので、ここでは「印を含む本文は高い」と申告させる。
 */
let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

/** この印を含む要素は、畳む高さを余裕ぶん以上に超えているものとして測られる。 */
const TALL = "【長い本文】";
/** 畳む高さは超えるが、隠れるのが余裕（COLLAPSE_SLACK_PX）に満たないもの。 */
const SLIGHTLY_TALL = "【やや長い】";
const descriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight",
);
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const text = this.textContent ?? "";
      if (everythingTall || text.includes(TALL)) {
        return COLLAPSED_BODY_PX + COLLAPSE_SLACK_PX + 1;
      }
      if (text.includes(SLIGHTLY_TALL)) return COLLAPSED_BODY_PX + 1;
      return 0;
    },
  });
});
afterEach(() => {
  if (descriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", descriptor);
  } else {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  }
});

/**
 * ResizeObserver を発火できる stub に差し替える。
 *
 * 高さは画像の読み込みや流入で**後から**伸びる。本物のブラウザでは
 * ResizeObserver がそれを届けるが、jsdom の既定の stub は何も届けない
 * ——「流れている最中に伸びても畳まない」は、届けてみなければ
 * 確かめようが無い。
 */
const observers = new Set<() => void>();
/** 印の無い本文も高いと申告させる（後から伸びた状況）。 */
let everythingTall = false;
const NativeRO = globalThis.ResizeObserver;
beforeEach(() => {
  observers.clear();
  everythingTall = false;
  globalThis.ResizeObserver = class {
    private cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
    }
    observe() {
      observers.add(this.cb);
    }
    unobserve() {}
    disconnect() {
      observers.delete(this.cb);
    }
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  globalThis.ResizeObserver = NativeRO;
});
/** 高さが変わったことを、見張っている全員に届ける。 */
const fireResize = () =>
  act(() => {
    for (const cb of observers) cb();
  });

const readMore = () => screen.queryByRole("button", { name: "続きを読む" });
const foldUp = () => screen.queryByRole("button", { name: "折りたたむ" });
/** 畳まれている本文の箱（無ければ null）。 */
const collapsedBox = () => document.querySelector("[data-collapsed]");

describe("開いたときに既に長い本文", () => {
  it("応答は畳まれ、本文はその中に在る", () => {
    renderChat({
      initialMessages: [
        msg("user", "質問", { id: "u1" }),
        msg("assistant", `${TALL} ここまで読めれば全文`, { id: "a1" }),
      ],
    });
    const box = collapsedBox();
    expect(box).toBeTruthy();
    // 隠れているだけで、本文はそこに在る（消して縮めているのではない）
    expect(box?.textContent).toContain("ここまで読めれば全文");
    expect(readMore()).toBeTruthy();
    expect(foldUp()).toBeNull();
  });

  it("自分の発言も同じく畳まれる", () => {
    renderChat({
      initialMessages: [msg("user", `${TALL} 長い質問`, { id: "u1" })],
    });
    expect(collapsedBox()?.textContent).toContain("長い質問");
    expect(readMore()).toBeTruthy();
  });

  it("「続きを読む」で開き、「折りたたむ」で戻る", async () => {
    const { user } = renderChat({
      initialMessages: [msg("assistant", `${TALL} 本文`, { id: "a1" })],
    });
    await user.click(readMore()!);
    expect(collapsedBox()).toBeNull();
    // 開いたあとも本文はそのまま
    expect(document.body.textContent).toContain("本文");
    expect(readMore()).toBeNull();

    await user.click(foldUp()!);
    expect(collapsedBox()).toBeTruthy();
    expect(readMore()).toBeTruthy();
  });

  /**
   * 数十px しか隠れないのに「続きを読む」を押させない。畳む高さを
   * 超えていても、隠れる量が余裕に満たなければそのまま出す。
   */
  it("少し超えるだけなら畳まない", () => {
    renderChat({
      initialMessages: [msg("assistant", `${SLIGHTLY_TALL} 本文`, { id: "a1" })],
    });
    expect(collapsedBox()).toBeNull();
    expect(readMore()).toBeNull();
    expect(screen.getByText(/本文/)).toBeTruthy();
  });

  it("短い本文には何も付かない", () => {
    renderChat({
      initialMessages: [
        msg("user", "短い質問", { id: "u1" }),
        msg("assistant", "短い答え", { id: "a1" }),
      ],
    });
    expect(collapsedBox()).toBeNull();
    expect(readMore()).toBeNull();
    expect(foldUp()).toBeNull();
    // 「無い」だけでなく、本文そのものは出ている
    expect(screen.getByText("短い答え")).toBeTruthy();
  });

  /**
   * コピーは全文。畳むのは見え方だけで、持っている本文には触れない。
   */
  it("畳まれていても、コピーは全文", async () => {
    const text = `${TALL} ここまで読めれば全文`;
    const { user } = renderChat({
      initialMessages: [msg("assistant", text, { id: "a1" })],
    });
    expect(collapsedBox()).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "コピー" }));
    // user-event が用意するクリップボードから読み戻す
    expect(await navigator.clipboard.readText()).toBe(text);
  });
});

/**
 * 選択モードでは行のタップが選択になる。「続きを読む」まで行のタップに
 * 数えると、開いたつもりで行が選ばれる（画像の拡大で同じことが起きた。
 * 監査 C-8）。
 */
describe("選択モード", () => {
  it("「続きを読む」を押しても、その行は選ばれない", async () => {
    const { user } = renderChat({
      initialMessages: [
        msg("user", "質問", { id: "u1" }),
        msg("assistant", `${TALL} 本文`, { id: "a1" }),
        msg("user", "次の質問", { id: "u2" }),
      ],
    });
    // 別の行のゴミ箱から選択モードへ（その1件が選ばれる）
    const trash = screen.getAllByRole("button", { name: "削除" });
    await user.click(trash[trash.length - 1]);
    await screen.findByText(/1件選択中/);

    await user.click(readMore()!);
    expect(collapsedBox()).toBeNull();
    // 開いただけで、選択は増えていない
    expect(screen.getByText(/1件選択中/)).toBeTruthy();
  });
});

/**
 * 流れている最中に畳むと、届く文字が隠れる。流れ終えた1通をその場で
 * 畳むと、読んでいる途中で本文が縮んで読み位置を失う。どちらも
 * 「畳まれていない」ことが正しく、**畳まれない**だけを見ると、機能
 * ごと外れていても通る。流れ終えたあとに「折りたたむ」が出ている
 * （＝長いと分かった上で開いている）ところまで見る。
 */
describe("目の前で流れた応答", () => {
  /**
   * 生成を始めた時点で応答の行が積まれる（追跡のテストと同じ）。完了時にも
   * 同じ並びを取り直すので、ここには確定後の本文を入れておく。
   */
  function stubGeneration(finalContent: string) {
    server.on("/generate", () => ({ userMessageId: "u1", assistantMessageId: "a1" }));
    server.on("/path", () => ({
      messages: [
        { id: "u1", role: "user", content: "質問", createdAt: 1 },
        { id: "a1", role: "assistant", content: finalContent, createdAt: 2 },
      ],
    }));
  }

  async function streamThenFinish(user: ReturnType<typeof renderChat>["user"]) {
    stubGeneration(`${TALL} 完成した応答`);
    let turn = 0;
    server.on("/messages/", () => {
      turn++;
      return {
        content: turn === 1 ? `${TALL} 書きかけ` : `${TALL} 完成した応答`,
        reasoning: null,
        status: turn === 1 ? "streaming" : "done",
        error: null,
        usage: null,
        citations: null,
      };
    });
    await user.type(await screen.findByRole("textbox"), "質問");
    await user.keyboard("{Enter}");
  }

  it("流れている最中は畳まない", async () => {
    // 1回目の途中経過で止める
    stubGeneration("");
    server.on("/messages/", () => ({
      content: `${TALL} 書きかけ`,
      reasoning: null,
      status: "streaming",
      error: null,
      usage: null,
      citations: null,
    }));
    const { user } = renderChat({});
    await user.type(await screen.findByRole("textbox"), "質問");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(document.body.textContent).toContain("書きかけ"),
    );
    expect(collapsedBox()).toBeNull();
    // 流入で高さが伸びたと届いても、測らない（測るのは流れ終えてから）
    fireResize();
    expect(collapsedBox()).toBeNull();
    // 「続きを読む」も「折りたたむ」も出ない
    expect(readMore()).toBeNull();
    expect(foldUp()).toBeNull();
  });

  it("流れ終えても畳まず、畳めるようにだけなる", async () => {
    const { user } = renderChat({});
    await streamThenFinish(user);
    await waitFor(() =>
      expect(document.body.textContent).toContain("完成した応答"),
    );
    // 長いと分かった上で、開いたまま
    await waitFor(() => expect(foldUp()).toBeTruthy());
    expect(collapsedBox()).toBeNull();

    // 押せば畳める
    await user.click(foldUp()!);
    expect(collapsedBox()).toBeTruthy();
  });
});

/**
 * 高さは描いたあとに変わる（画像の読み込み・幅の変化）。開いたときに
 * 短くて、あとから伸びたものも畳む。届けるのは ResizeObserver。
 */
describe("あとから伸びた本文", () => {
  it("伸びたと届いた時点で畳む", () => {
    renderChat({
      initialMessages: [msg("assistant", "最初は短い", { id: "a1" })],
    });
    expect(readMore()).toBeNull();

    everythingTall = true;
    fireResize();
    expect(collapsedBox()?.textContent).toContain("最初は短い");
    expect(readMore()).toBeTruthy();
  });
});
