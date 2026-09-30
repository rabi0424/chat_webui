import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import {
  installServer,
  msg,
  renderChat,
  type ServerStub,
} from "./helpers/chat-harness";
import { editDraftKey } from "../../app/lib/edit-draft";

/**
 * 書き直しの途中で画面を読み込み直しても、同じ発言の上に編集中で戻る。
 *
 * 編集欄は画面の状態だけで持っていたので、再読み込み（iPhone で PWA を
 * 切り替えて戻ったときに勝手に起きるものも含む）で打ちかけの書き直しが
 * 丸ごと消えていた。
 *
 * 読み込み直しは「画面を外して、同じ会話で作り直す」で再現する。
 * 端末の保存（localStorage）は外しても残る。
 */
const CONV = "conv-1";
let server: ServerStub;
const conversation = () => [
  msg("user", "最初の質問", { id: "u1" }),
  msg("assistant", "最初の応答", { id: "a1" }),
  msg("user", "2つ目の質問", { id: "u2" }),
  msg("assistant", "2つ目の応答", { id: "a2" }),
];

beforeEach(() => {
  server = installServer(conversation());
  localStorage.clear();
});

function open() {
  return renderChat({ conversationId: CONV, initialMessages: conversation() });
}

/** 最初の発言を書き直しかけて、画面を作り直す。 */
async function editFirstThenReload(text: string) {
  const { user } = open();
  await user.click((await screen.findAllByLabelText("編集して再送信"))[0]);
  const box = await screen.findByDisplayValue("最初の質問");
  await user.clear(box);
  await user.type(box, text);
  cleanup();
  return open();
}

describe("再読み込みで編集中に戻る", () => {
  it("打ちかけの文が、同じ発言の編集欄に戻る", async () => {
    await editFirstThenReload("書き直しかけ");

    expect(await screen.findByDisplayValue("書き直しかけ")).toBeTruthy();
    // 付き替わっていないこと: 書き直していた発言は吹き出しとしては
    // 出ておらず、隣の発言は元のまま出ている
    expect(screen.queryByText("最初の質問")).toBeNull();
    expect(screen.getByText("2つ目の質問")).toBeTruthy();
    expect(screen.getByText("最初の応答")).toBeTruthy();
  });

  it("戻したあと続けて保存すると、書き直した発言として送られる", async () => {
    const { user } = await editFirstThenReload("続きから");
    const box = await screen.findByDisplayValue("続きから");
    await user.type(box, "足した");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(server.lastBody(`/api/conversations/${CONV}/messages`)).toMatchObject({
        parentId: null,
        content: "続きから足した",
      });
    });
  });

  it("キャンセルしたら、次に開いたときは戻らない", async () => {
    const { user } = open();
    await user.click((await screen.findAllByLabelText("編集して再送信"))[0]);
    await screen.findByDisplayValue("最初の質問");
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.getByText("最初の質問")).toBeTruthy());
    cleanup();

    open();
    expect(await screen.findByText("最初の質問")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "キャンセル" })).toBeNull();
    expect(localStorage.getItem(editDraftKey(CONV))).toBeNull();
  });

  it("保存したら、次に開いたときは戻らない", async () => {
    const { user } = open();
    await user.click((await screen.findAllByLabelText("編集して再送信"))[0]);
    const box = await screen.findByDisplayValue("最初の質問");
    await user.type(box, "直した");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(server.countOf(`/api/conversations/${CONV}/messages`)).toBe(1),
    );
    await waitFor(() =>
      expect(localStorage.getItem(editDraftKey(CONV))).toBeNull(),
    );
  });

  it("別の会話を開いても、そちらには出ない", async () => {
    await editFirstThenReload("この会話だけ");
    cleanup();
    renderChat({ conversationId: "conv-2", initialMessages: conversation() });
    expect(await screen.findByText("最初の質問")).toBeTruthy();
    expect(screen.queryByDisplayValue("この会話だけ")).toBeNull();
  });

  it("書き直していた発言が今の枝に無ければ、理由を出して畳む", async () => {
    localStorage.setItem(
      editDraftKey(CONV),
      JSON.stringify({ id: "gone", text: "消えた枝の書き直し", attachments: [] }),
    );
    open();
    expect(
      await screen.findByText("編集していた発言は、この枝にはありません"),
    ).toBeTruthy();
    expect(screen.queryByDisplayValue("消えた枝の書き直し")).toBeNull();
    expect(screen.getByText("最初の質問")).toBeTruthy();
  });
});

/**
 * 戻した編集欄が画面の中に出る。
 *
 * 開いた直後の画面は最下部へ貼り付き、段階描画や Markdown の到着のたびに
 * 貼り直す。何もしなければ、上のほうの発言を書き直していた場合は編集欄が
 * 画面の外に置かれたままになる。
 *
 * jsdom は配置を計算しないので、スクロールする箱と編集欄の位置を作る。
 * 編集欄は箱の中身の EDITOR_Y にあり、画面上の位置はスクロールした
 * ぶんだけ上がる（本物のブラウザと同じく、合わせ直すたびに測り直す）。
 */
describe("戻した編集欄へスクロールする", () => {
  const CLIENT_H = 600;
  const CONTENT_H = 50000;
  const EDITOR_Y = 1500;
  const EDITOR_H = 100;
  /**
   * 編集欄の、箱の中身の上端からの位置。上に描かれている発言が増えると
   * 押し下がる（段階描画で古い発言が足されたとき）。発言1件あたり
   * ROW_H として、編集欄より前にある「編集して再送信」の数で数える。
   */
  const ROW_H = 200;
  const editorY = (editor: Element) =>
    EDITOR_Y +
    ROW_H *
      [...document.querySelectorAll('[aria-label="編集して再送信"]')].filter(
        (b) =>
          b.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).length;
  const tops = new WeakMap<Element, number>();
  /** 箱の位置を動かした履歴（開いた直後にどこへ行ったか）。 */
  let moves: number[] = [];
  const isBox = (el: Element) => el.matches(".overflow-y-auto");

  beforeEach(() => {
    moves = [];
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0;
      },
      set(this: HTMLElement, v: number) {
        const max = isBox(this) ? CONTENT_H - CLIENT_H : 0;
        const next = Math.max(0, Math.min(v, max));
        if (next === (tops.get(this) ?? 0)) return;
        tops.set(this, next);
        if (isBox(this)) moves.push(next);
        // 本物と同じく、動いたことの通知は**あとから**届く。開いた直後に
        // 最下部へ合わせたぶんの通知が、編集欄へ合わせたあとに届いて
        // 「最下部に居る」と読まれ、貼り付きが戻る——デスクトップの
        // Chromium で実際に起きた（最下部へ引き戻された）
        setTimeout(() => this.dispatchEvent(new Event("scroll")), 0);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => CONTENT_H,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => CLIENT_H,
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this.matches("[data-message-editor]")) {
          const box = this.closest(".overflow-y-auto");
          const top = editorY(this) - (box ? (tops.get(box) ?? 0) : 0);
          return new DOMRect(0, top, 300, EDITOR_H);
        }
        return new DOMRect(0, 0, 300, isBox(this) ? CLIENT_H : 0);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // 箱の寸法の差し替えを外す（プロトタイプに生やしたものを消す）
    for (const k of ["scrollTop", "scrollHeight", "clientHeight"]) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
    }
  });

  it("編集欄が箱の真ん中に来る位置まで戻す（最下部に貼り付いたままにしない）", async () => {
    localStorage.setItem(
      editDraftKey(CONV),
      JSON.stringify({ id: "u1", text: "上のほうの書き直し", attachments: [] }),
    );
    open();
    expect(await screen.findByDisplayValue("上のほうの書き直し")).toBeTruthy();

    const box = document.querySelector(".absolute.inset-0.overflow-y-auto");
    expect(box).toBeTruthy();
    // 編集欄の中心が箱の中心に来る位置（上に発言が無いので押し下げは無い）
    const centered = EDITOR_Y - (CLIENT_H - EDITOR_H) / 2;
    // 描画の段が進み Markdown が届いたあとも（最下部へ貼り直す機会を
    // 過ぎたあとも）そこに居る
    await waitFor(() => expect((box as HTMLElement).scrollTop).toBe(centered));
    await new Promise((r) => setTimeout(r, 50));
    expect((box as HTMLElement).scrollTop).toBe(centered);
  });

  it("開いた直後に、いったん最下部へ合わせることもしない", async () => {
    // 最下部へ合わせると、その動きの通知が遅れて届いて「最下部に居る」と
    // 読まれ、外した貼り付きが戻る。デスクトップの Chromium では、その後の
    // 描き直しで最下部へ引き戻された（jsdom では通知の届く順が本物と
    // 違って引き戻しまでは再現しないので、原因のほうを見る）
    localStorage.setItem(
      editDraftKey(CONV),
      JSON.stringify({ id: "u1", text: "上のほうの書き直し", attachments: [] }),
    );
    open();
    expect(await screen.findByDisplayValue("上のほうの書き直し")).toBeTruthy();
    const centered = EDITOR_Y - (CLIENT_H - EDITOR_H) / 2;
    await waitFor(() => expect(moves.at(-1)).toBe(centered));
    await new Promise((r) => setTimeout(r, 50));
    expect(moves).not.toContain(CONTENT_H - CLIENT_H);
    // 見張りが空振りしていないこと: 編集中でなければ最下部へ合わせる
    cleanup();
    localStorage.clear();
    moves = [];
    open();
    await screen.findByText("最初の質問");
    await waitFor(() => expect(moves).toContain(CONTENT_H - CLIENT_H));
  });

  it("書き直していた発言が枝に無ければ、いつもどおり最下部から始める", async () => {
    localStorage.setItem(
      editDraftKey(CONV),
      JSON.stringify({ id: "gone", text: "消えた枝の書き直し", attachments: [] }),
    );
    open();
    expect(
      await screen.findByText("編集していた発言は、この枝にはありません"),
    ).toBeTruthy();
    const box = document.querySelector(".absolute.inset-0.overflow-y-auto");
    await waitFor(() =>
      expect((box as HTMLElement).scrollTop).toBe(CONTENT_H - CLIENT_H),
    );
  });

  it("古い発言があとから上に足されても、編集欄に合わせ直す", async () => {
    // 末尾だけを先に描く長さの会話で、末尾の範囲に入る発言を書き直す。
    // 最初の描画では編集欄の上に数件しか無く、全件へ広げると上に
    // 古い発言が足されて押し下がる。1度合わせて終わりにすると、
    // 押し下がった編集欄が画面の外へ出る
    const long = Array.from({ length: 20 }, (_, i) => [
      msg("user", `質問${i}`, { id: `u${i}` }),
      msg("assistant", `応答${i}`, { id: `a${i}` }),
    ]).flat();
    server = installServer(long);
    localStorage.setItem(
      editDraftKey(CONV),
      JSON.stringify({ id: "u14", text: "末尾のほうの書き直し", attachments: [] }),
    );
    renderChat({ conversationId: CONV, initialMessages: long });
    const editor = (await screen.findByDisplayValue("末尾のほうの書き直し"))
      .closest("[data-message-editor]")!;
    // 全件が描かれた（最初の発言まで出た）あとで見る
    expect(await screen.findByText("質問0")).toBeTruthy();

    const box = document.querySelector(".absolute.inset-0.overflow-y-auto");
    const centered = editorY(editor) - (CLIENT_H - EDITOR_H) / 2;
    // 全件のときの位置は、上に14件ぶん押し下がっている
    expect(editorY(editor)).toBe(EDITOR_Y + 14 * ROW_H);
    await waitFor(() => expect((box as HTMLElement).scrollTop).toBe(centered));
  });
});
