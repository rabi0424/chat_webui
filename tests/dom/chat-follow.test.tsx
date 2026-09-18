import { beforeEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import {
  installServer,
  msg,
  renderChat,
  type ServerStub,
} from "./helpers/chat-harness";

/**
 * 生成中の自動追従。
 *
 * 最下部の近くに居るあいだは本文が伸びるのを追いかけ、離れて読んでいる
 * あいだは位置をそのままにする。この「近くに居るか」の印は `scroll` の
 * 通知でしか更新できないが、**通知は後から来る**——iOS Safari は
 * スクロールをコンポジタ側で進め、通知はあとでまとめて届く。
 *
 * 指で上へ払った直後に本文の更新が入ると、印はまだ「最下部に居る」まま
 * なので、読んでいた位置から最下部へ引き戻される。生成の確定は、確定した
 * 全文の描き直し・図の描画・パスの取り直し・一覧の取り直しが重なって
 * いちばん忙しく、この隙間がいちばん開く——「生成が終わった瞬間に
 * 最下部へ飛ぶ」のはこれ。
 *
 * jsdom は配置を計算しないので、スクロールする箱の寸法はここで作る。
 * 見たいのは**アプリ側の判断**（測り直すか、印をそのまま使うか）で、
 * ブラウザの配置そのものではない。
 */

const CLIENT_H = 800;
const START_H = 3000;
/**
 * ポーリング1回ぶんの本文の伸び（px）。
 *
 * 払う量（400px）より速く積み上がる大きさにしてある。追従しているあいだに
 * 伸びたぶんを控え直していないと、**払ったのに「下へ動いた」ことになって
 * 気づけない**——そこを見たいので、数回で払う量を追い越す必要がある。
 */
const GROW_PX = 300;

let server: ServerStub;

beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

/** 生成中の応答を1件持った会話を出し、ポーリングを走らせる。 */
function renderStreaming() {
  let content = "生成の途中です。";
  server.on("/messages/", () => {
    content += "本文がすこし伸びました。";
    return {
      content,
      reasoning: null,
      status: "streaming",
      error: null,
      usage: null,
      citations: null,
    };
  });
  return renderChat({
    initialMessages: [
      msg("user", "質問です", { id: "u1" }),
      msg("assistant", "", { id: "a1", status: "streaming" }),
    ],
  });
}

/**
 * スクロールする箱の寸法を差し替える。
 *
 * `drag` は**通知を出さずに**位置だけを動かす（指で払ったが、まだ
 * `scroll` が届いていない状態）。`notify` はその通知。
 */
function installViewport() {
  const el = document.querySelector(
    ".absolute.inset-0.overflow-y-auto",
  ) as HTMLElement | null;
  if (!el) throw new Error("スクロール領域が見つかりません");
  let top = 0;
  let height = START_H;
  const clamp = (v: number) => Math.max(0, Math.min(v, height - CLIENT_H));
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => CLIENT_H,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => height,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = clamp(v);
    },
  });
  return {
    el,
    get top() {
      return top;
    },
    bottom: () => height - CLIENT_H,
    grow: (px = GROW_PX) => {
      height += px;
    },
    drag: (to: number) => {
      top = clamp(to);
    },
    notify: () => el.dispatchEvent(new Event("scroll", { bubbles: true })),
  };
}

/**
 * 本文の更新を待ち、受け取ったぶん箱の中身を伸ばす、を繰り返す。
 *
 * **1回では足りない。** 追従は「前に合わせた位置から動いたか」で判断
 * するので、控えを取り違えていても最初の1回はたまたま当たる。何度か
 * 続けて初めて、控えが正しく更新されているかが出る。
 */
async function keepStreaming(view: { grow: () => void }, times = 3) {
  for (let i = 0; i < times; i++) {
    const before = server.countOf("/messages/");
    await waitFor(() =>
      expect(server.countOf("/messages/")).toBeGreaterThan(before),
    );
    // 受け取ったぶん、箱の中身が伸びる
    view.grow();
    await waitFor(() =>
      expect(server.countOf("/messages/")).toBeGreaterThan(before + 1),
    );
  }
}

/** 画面の組み立て（段階的な描画とその追従）が落ち着くまで待つ。 */
async function settled() {
  await waitFor(() =>
    expect(server.countOf("/messages/")).toBeGreaterThan(1),
  );
}

/** 画面と、寸法を差し替えた箱を用意する。 */
function setup() {
  renderStreaming();
  return installViewport();
}

describe("生成中の自動追従", () => {
  /**
   * 本題。通知が遅れているあいだに本文が更新されても、読んでいた位置を
   * 動かさない（印ではなく、そのときの位置を見て決める）。
   */
  it("通知が届く前に上へ払っても、最下部へ引き戻さない", async () => {
    const view = setup();
    await settled();
    // まず最下部に貼り付いた状態にする（通知まで届いている）
    view.drag(view.bottom());
    view.notify();
    // しばらく追いかけさせる。**ここを飛ばすと足りない**——追従が
    // 合わせた位置を控え直していなくても、貼り付いた直後なら通知の値が
    // たまたま合っていて、上へ払ったことに気づける
    await keepStreaming(view, 2);


    // 指で上へ払った。位置は動いたが、通知はまだ届いていない
    const reading = view.top - 400;
    view.drag(reading);

    await keepStreaming(view);

    expect(view.top).toBe(reading);
  });

  /** 追従そのものを止めてしまっていないか（これが動かないと生成が読めない）。 */
  it("最下部に居るあいだは、伸びたぶんを追いかける", async () => {
    const view = setup();
    await settled();
    view.drag(view.bottom());
    view.notify();

    await keepStreaming(view);

    expect(view.top).toBe(view.bottom());
  });

  /**
   * 離れて読んだあと、自分で最下部まで戻したら追従が再開する。
   *
   * 戻したのは利用者なので、こちらが合わせた位置とは違う。そこを
   * 控え直していないと、次に本文が伸びた時点で「離れた」と判定され、
   * 最下部に居るのに追いかけなくなる。
   */
  it("自分で最下部まで戻したら、また追いかける", async () => {
    const view = setup();
    await settled();
    // いったん離れて読む
    view.drag(view.bottom() - 500);
    view.notify();
    await keepStreaming(view, 1);
    // 自分で最下部まで戻した
    view.drag(view.bottom());
    view.notify();

    await keepStreaming(view);

    expect(view.top).toBe(view.bottom());
  });

  /**
   * 最下部へ戻した直後にまた上へ払っても、引き戻さない。
   *
   * 戻したときの位置を控え直していないと、離れて読んでいたときの位置が
   * 残る。そこから測ると「上へ動いた」ことにならず（むしろ下へ動いた
   * ことになる）、払ったのに貼り付いたままになる。
   */
  it("最下部へ戻した直後にまた払っても、引き戻さない", async () => {
    const view = setup();
    await settled();
    // いったん離れて読む（そのあいだも本文は伸び続ける）
    view.drag(view.bottom() - 500);
    view.notify();
    await keepStreaming(view, 2);
    // 最下部まで戻し（通知あり）、すぐまた上へ払う（通知はまだ）
    view.drag(view.bottom());
    view.notify();
    const reading = view.top - 400;
    view.drag(reading);

    await keepStreaming(view);

    expect(view.top).toBe(reading);
  });

  /**
   * 数行だけ戻したときは、これまでどおり貼り付いたままにする
   * （80px の窓の中は「最下部に居る」扱い）。
   */
  it("少しだけ戻したぶんには、これまでどおり追いつく", async () => {
    const view = setup();
    await settled();
    view.drag(view.bottom());
    view.notify();

    view.drag(view.bottom() - 30);

    await keepStreaming(view);

    expect(view.top).toBe(view.bottom());
  });
});
