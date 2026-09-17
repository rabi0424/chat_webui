import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  installServer,
  msg,
  renderChat,
  type ServerStub,
} from "./helpers/chat-harness";
import type { UiMessage } from "../../app/lib/types";

/**
 * 閉じていたあいだに進んだぶんを、戻ってきたときに拾い直す。
 *
 * ブラウザを閉じて開き直すと、Safari は前に開いていた画面をそのまま
 * 復元することがある。文書を取り直していないので、閉じているあいだに
 * サーバーで進んだぶんが抜けたまま出る——利用者からは「最新のメッセージが
 * 欠けたページが読み込まれ、再読み込みすると直る」という形で見える。
 *
 * 文書そのものを溜めさせない手当ては入口（entry.server）で行っているが、
 * それは**取り直すとき**の話で、画面ごと復元される経路には効かない。
 */

const HERE: UiMessage[] = [
  msg("user", "前の発言", { id: "u1" }),
  msg("assistant", "前の応答", { id: "a1" }),
];

let server: ServerStub;

beforeEach(() => {
  server = installServer([...HERE]);
  localStorage.clear();
  setVisibility("visible");
});

afterEach(() => {
  setVisibility("visible");
});

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

/**
 * bfcache／タブの復元。jsdom には PageTransitionEvent が無いので、
 * 見ているところ（persisted）だけを持つ値を渡す。
 */
function firePageShow(persisted: boolean): void {
  const e = new Event("pageshow");
  Object.defineProperty(e, "persisted", { value: persisted });
  window.dispatchEvent(e);
}

/** 閉じているあいだにサーバー側で会話が進んだ、という状況を作る。 */
function advanceServer(): void {
  server.messages.push(
    msg("user", "閉じている間の発言", { id: "u2" }),
    msg("assistant", "閉じている間の応答", { id: "a2" }),
  );
}

/** 画面が出来上がるまで待つ（聞き耳を立てるのはマウント後の効果）。 */
async function mounted(): Promise<void> {
  expect(await screen.findByText("前の応答")).toBeTruthy();
}

describe("戻ってきたときの取り直し", () => {
  it("復元された画面では、閉じている間に増えた応答が出る", async () => {
    renderChat({ initialMessages: [...HERE] });
    await mounted();
    advanceServer();

    firePageShow(true);

    expect(await screen.findByText("閉じている間の応答")).toBeTruthy();
  });

  it("アプリから戻ったとき（画面が見えたとき）も取り直す", async () => {
    renderChat({ initialMessages: [...HERE] });
    await mounted();
    advanceServer();

    document.dispatchEvent(new Event("visibilitychange"));

    expect(await screen.findByText("閉じている間の応答")).toBeTruthy();
  });

  /**
   * 復元ではない `pageshow`（ふつうの読み込み）では取り直さない。
   * 文書と一緒に届いたばかりの内容なので、開くたびに1往復増やす意味がない。
   */
  it("ふつうの読み込みでは取り直さない", async () => {
    renderChat({ initialMessages: [...HERE] });
    await mounted();
    advanceServer();

    firePageShow(false);
    await new Promise((r) => setTimeout(r, 30));

    expect(server.countOf("/path")).toBe(0);
    // 取り直していないだけで、画面はそのまま出ている
    expect(screen.getByText("前の応答")).toBeTruthy();
  });

  /** 隠れるときの visibilitychange で取りに行くと、裏で無駄に往復する。 */
  it("画面が隠れるときは取り直さない", async () => {
    renderChat({ initialMessages: [...HERE] });
    await mounted();
    advanceServer();

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 30));

    expect(server.countOf("/path")).toBe(0);
    expect(screen.getByText("前の応答")).toBeTruthy();
  });

  /**
   * 生成を追っているあいだは割り込まない。ポーリングが同じ場所を
   * 更新しているので、ここで取り直すと組み立てた途中経過を一度
   * 古い本文で塗り替えることになる。
   */
  it("生成を追っているあいだは割り込まない", async () => {
    server.on("/messages/", () => ({
      content: "生成の途中です",
      reasoning: null,
      status: "streaming",
      error: null,
      usage: null,
      citations: null,
    }));
    renderChat({
      initialMessages: [
        msg("user", "前の発言", { id: "u1" }),
        msg("assistant", "", { id: "a1", status: "streaming" }),
      ],
    });
    // 追跡が始まって、途中経過が出るまで待つ
    await waitFor(() =>
      expect(document.body.textContent).toContain("生成の途中です"),
    );

    firePageShow(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 30));

    expect(server.countOf("/path")).toBe(0);
    // 追跡は続いている（割り込まないだけで、止めてはいない）
    await waitFor(() =>
      expect(server.countOf("/messages/")).toBeGreaterThan(1),
    );
  });
});
