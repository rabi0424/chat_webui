import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCopied } from "../../app/lib/use-copied";

/**
 * 「コピーしました」の一時表示。
 *
 * 同じ形が5箇所にあり、どれも setTimeout を張りっぱなしにしていた。
 * React 18 以降、外れたあとの setState は黙って無視されるので害は
 * 出ないが、続けて押したときに**前の時計が先に鳴って印が早く消える**
 * ——2回目を押した0.1秒後にチェックが消える、という挙動になっていた。
 */
describe("コピーの印", () => {
  it("押すと出て、しばらくして消える", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopied(1000));
    expect(result.current[0]).toBe(false);

    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);

    act(() => void vi.advanceTimersByTime(999));
    expect(result.current[0]).toBe(true);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current[0]).toBe(false);
    vi.useRealTimers();
  });

  /** これが直したかったところ。 */
  it("続けて押すと、時計が張り直される", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopied(1000));

    act(() => result.current[1]());
    act(() => void vi.advanceTimersByTime(900));
    act(() => result.current[1]()); // 2回目

    // 1回目の時計が鳴るはずだった時刻を過ぎても、まだ出ている
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current[0]).toBe(true);

    // 2回目から数えて消える
    act(() => void vi.advanceTimersByTime(800));
    expect(result.current[0]).toBe(false);
    vi.useRealTimers();
  });

  it("外れたら時計も止める", () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const { result, unmount } = renderHook(() => useCopied(1000));
    act(() => result.current[1]());
    clear.mockClear();

    unmount();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
    vi.useRealTimers();
  });

  it("押す関数は作り直されない", () => {
    const { result, rerender } = renderHook(() => useCopied(1000));
    const first = result.current[1];
    rerender();
    expect(result.current[1]).toBe(first);
  });
});
