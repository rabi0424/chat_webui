/**
 * 1件ぶんの受け皿（MessageBoundary）。
 *
 * 画面翻訳が節点を差し替えたあとの描き直しで落ちたとき、画面ごと
 * 「読み込めませんでした」に差し替わらないようにするための網。
 * 見るのは3つ:
 *
 *  1. DOM の衝突なら、その1件を作り直して画面に戻す
 *  2. それ以外の失敗は素通しする（こちらの作りの誤りを隠さない）
 *  3. 作り直しても落ち続けるなら諦めて上へ渡す（点滅し続けない）
 *
 * **失敗は描画ではなく commit（DOM を触る段）で起こす。** 描画の途中で
 * 投げると React は同じ根をもう一度描き直して勝手に復帰してしまい、
 * 受け皿まで届かない——それに気づかないまま書いた最初の版は、受け皿を
 * 丸ごと外しても通っていた。本物の失敗も DOM を触る段で出る。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Component, useLayoutEffect, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { MessageBoundary } from "../../app/components/chat/MessageBoundary";

/** ルート側の受け皿の代役。ここまで上がったら「渡った」とみなす。 */
class OuterBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <p>上へ渡った</p> : this.props.children;
  }
}

function domError(): Error {
  const e = new Error("The object can not be found here.");
  e.name = "NotFoundError";
  return e;
}

/** 何回目の commit まで落ちるか。props ではなくここに置くのは、
 *  useLayoutEffect を「マウントのたびに1回」に保つため。 */
let mounts = 0;
let plan: { failFor: number; make: () => unknown } = {
  failFor: 0,
  make: () => new Error("使わない"),
};

function Body() {
  useLayoutEffect(() => {
    mounts += 1;
    if (mounts <= plan.failFor) throw plan.make();
  }, []);
  return <p>本文は出ている</p>;
}

beforeEach(() => {
  mounts = 0;
  // React は受け皿が拾った失敗も console へ出す。読みたいのは検査の
  // 結果だけなので黙らせる（出ること自体は仕様）
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("1件ぶんの受け皿", () => {
  it("DOM の衝突なら、作り直して本文を画面に戻す", () => {
    plan = { failFor: 1, make: domError };
    render(
      <OuterBoundary>
        <MessageBoundary>
          <Body />
        </MessageBoundary>
      </OuterBoundary>,
    );
    expect(screen.getByText("本文は出ている")).toBeTruthy();
    // 上へは渡っていない（画面ごと差し替わっていない）
    expect(screen.queryByText("上へ渡った")).toBeNull();
    // 作り直しは1回だけ
    expect(mounts).toBe(2);
  });

  it("DOM の衝突でなければ、そのまま上へ渡す", () => {
    plan = { failFor: 1, make: () => new TypeError("読めない値") };
    render(
      <OuterBoundary>
        <MessageBoundary>
          <Body />
        </MessageBoundary>
      </OuterBoundary>,
    );
    expect(screen.getByText("上へ渡った")).toBeTruthy();
    expect(screen.queryByText("本文は出ている")).toBeNull();
    // 作り直して握り潰していない
    expect(mounts).toBe(1);
  });

  it("作り直しても落ち続けるなら、諦めて上へ渡す", () => {
    plan = { failFor: Infinity, make: domError };
    render(
      <OuterBoundary>
        <MessageBoundary>
          <Body />
        </MessageBoundary>
      </OuterBoundary>,
    );
    expect(screen.getByText("上へ渡った")).toBeTruthy();
    // 上限（3回）ぶんだけ作り直して止まっている。止まらなければ、
    // ここへ来る前に描画が終わらない
    expect(mounts).toBe(4);
  });

  it("まとめて投げられた失敗の中も見る", () => {
    plan = {
      failFor: 1,
      make: () => new AggregateError([domError()], "まとめ"),
    };
    render(
      <OuterBoundary>
        <MessageBoundary>
          <Body />
        </MessageBoundary>
      </OuterBoundary>,
    );
    expect(screen.getByText("本文は出ている")).toBeTruthy();
    expect(screen.queryByText("上へ渡った")).toBeNull();
  });
});
