import { describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEscapeToClose } from "../../app/lib/dismiss";
import { Lightbox } from "../../app/components/Lightbox";
import { ModelPicker } from "../../app/components/ModelPicker";
import { TEST_MODEL } from "./helpers/chat-harness";

/**
 * Escape で閉じる。
 *
 * 難しいのは重なっているとき。listener の登録順に頼ると、順番は
 * 「開いた順」で決まってしまう——奥にあるものを先に開いていれば
 * そちらが先に反応し、手前のものが残る。
 */
const escape = (user: ReturnType<typeof userEvent.setup>) =>
  user.keyboard("{Escape}");

describe("Escape で閉じる", () => {
  it("開いていれば閉じる", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    renderHook(() => useEscapeToClose(true, close));
    await escape(user);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("開いていなければ反応しない", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    renderHook(() => useEscapeToClose(false, close));
    await escape(user);
    expect(close).not.toHaveBeenCalled();
  });

  it("Escape 以外では閉じない", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    renderHook(() => useEscapeToClose(true, close));
    await user.keyboard("{Enter}a{Tab}");
    expect(close).not.toHaveBeenCalled();
  });

  it("閉じたあとは反応しなくなる", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    const { rerender } = renderHook(
      ({ open }) => useEscapeToClose(open, close),
      { initialProps: { open: true } },
    );
    rerender({ open: false });
    await escape(user);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("重なっているとき", () => {
  /** 開いた順に2枚。手前は後から開いたほう。 */
  function Two({
    onBack,
    onFront,
    frontOpen,
  }: {
    onBack: () => void;
    onFront: () => void;
    frontOpen: boolean;
  }) {
    useEscapeToClose(true, onBack);
    useEscapeToClose(frontOpen, onFront);
    return null;
  }

  it("一度の Escape で閉じるのは一番手前の1枚だけ", async () => {
    const user = userEvent.setup();
    const back = vi.fn();
    const front = vi.fn();
    render(<Two onBack={back} onFront={front} frontOpen />);
    await escape(user);
    expect(front).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
  });

  it("手前を閉じたら、次の Escape で奥が閉じる", async () => {
    const user = userEvent.setup();
    const back = vi.fn();
    const front = vi.fn();
    const { rerender } = render(
      <Two onBack={back} onFront={front} frontOpen />,
    );
    await escape(user);
    expect(front).toHaveBeenCalledTimes(1);

    // 手前が閉じた状態にする
    rerender(<Two onBack={back} onFront={front} frontOpen={false} />);
    await escape(user);
    expect(back).toHaveBeenCalledTimes(1);
  });

  /**
   * 奥を「あとから」開いた場合。登録順に頼っていると、こちらが
   * 手前より後に登録され、先に反応してしまう。
   */
  it("開いた順が逆でも、手前が優先される", async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();

    function Late({ lateOpen }: { lateOpen: boolean }) {
      useEscapeToClose(true, first);
      useEscapeToClose(lateOpen, second);
      return null;
    }
    const { rerender } = render(<Late lateOpen={false} />);
    rerender(<Late lateOpen />);

    await escape(user);
    // あとから開いたほうが手前
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

/**
 * 自前で Escape を見ていたもの。
 *
 * 拡大表示とモデル一覧は、共通の重なり順に加わらないまま自分で keydown を
 * 見ていた。すると Escape が2箇所で拾われ、一度押しただけで2枚——手前の
 * ものと、その下のパネル——が同時に閉じていた（監査 C-7）。
 */
describe("重なり順に加わる", () => {
  it("拡大表示を Escape で閉じても、下のものは開いたまま", async () => {
    const user = userEvent.setup();
    const back = vi.fn();
    const close = vi.fn();

    function Layered({ zoomed }: { zoomed: boolean }) {
      // 下に開いているパネル（⚙など）に相当する
      useEscapeToClose(true, back);
      return zoomed ? (
        <Lightbox src="/api/files/att-1" onClose={close} />
      ) : null;
    }
    // 実際の順番に合わせる（パネルが開いている上で、画像を拡大する）
    const { rerender } = render(<Layered zoomed={false} />);
    rerender(<Layered zoomed />);

    await escape(user);
    expect(close).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
  });

  it("拡大表示の矢印キーは残っている", async () => {
    const user = userEvent.setup();
    const next = vi.fn();
    render(
      <Lightbox src="/api/files/att-1" onClose={() => {}} onNext={next} />,
    );
    await user.keyboard("{ArrowRight}");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("モデル一覧を Escape で閉じても、下のものは開いたまま", async () => {
    const user = userEvent.setup();
    const back = vi.fn();

    function Layered() {
      useEscapeToClose(true, back);
      return (
        <ModelPicker
          models={[TEST_MODEL]}
          value={TEST_MODEL.id}
          newModelDays={0}
          onChange={() => {}}
        />
      );
    }
    render(<Layered />);
    await user.click(screen.getByRole("button"));
    expect(await screen.findByLabelText("モデルを検索")).toBeTruthy();

    await escape(user);
    // 一覧は閉じる（＝手前の1枚は確かに反応している）
    await waitFor(() =>
      expect(screen.queryByLabelText("モデルを検索")).toBeNull(),
    );
    // 下のものまで巻き込まない
    expect(back).not.toHaveBeenCalled();
  });
});
