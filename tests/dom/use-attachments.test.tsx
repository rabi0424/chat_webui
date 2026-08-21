import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAttachments } from "../../app/components/chat/use-attachments";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../app/lib/constants";

/**
 * 送信前の添付。
 *
 * 上限の数え方に癖がある（反映を待たずに連続で落とされるため、
 * state ではなく押さえた枚数で数える）。ここが緩むと上限を超えて
 * 添付できてしまい、送信時にサーバー側で切り捨てられる。
 */
// 画像の縮小はブラウザの機能（canvas）に依るので、テストでは素通しする
vi.mock("../../app/lib/image", async (orig) => {
  const actual = await orig<typeof import("../../app/lib/image")>();
  return { ...actual, prepareImage: async (f: File) => f };
});

let uploaded = 0;
beforeEach(() => {
  uploaded = 0;
  globalThis.fetch = (async () => {
    uploaded++;
    return new Response(
      JSON.stringify({ id: `att-${uploaded}`, size: 100, mimeType: "image/png" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});

const png = (name: string) =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

function setup() {
  const errors: (string | null)[] = [];
  const hook = renderHook(() =>
    useAttachments({ setError: (m) => errors.push(m) }),
  );
  return { hook, errors };
}

describe("添付の追加", () => {
  it("画像を足すとアップロードされ、使える状態になる", async () => {
    const { hook } = setup();
    await act(async () => {
      await hook.result.current.addFiles([png("a.png")]);
    });
    await waitFor(() => {
      expect(hook.result.current.pending).toHaveLength(1);
      expect(hook.result.current.pending[0].status).toBe("ready");
      expect(hook.result.current.pending[0].id).toBe("att-1");
    });
  });

  it("画像でないものは足さない", async () => {
    const { hook, errors } = setup();
    const txt = new File(["text"], "a.txt", { type: "text/plain" });
    await act(async () => {
      await hook.result.current.addFiles([txt]);
    });
    expect(hook.result.current.pending).toHaveLength(0);
    expect(errors.some((e) => e?.includes("画像ファイルのみ"))).toBe(true);
  });

  it("上限を超えて足さない", async () => {
    const { hook } = setup();
    const many = Array.from({ length: 20 }, (_, i) => png(`${i}.png`));
    await act(async () => {
      await hook.result.current.addFiles(many);
    });
    await waitFor(() =>
      expect(hook.result.current.pending).toHaveLength(
        MAX_ATTACHMENTS_PER_MESSAGE,
      ),
    );
  });

  it("反映を待たずに連続で足しても上限を守る", async () => {
    // 1回目の結果が state に反映される前に2回目が来る状況。
    // 押さえた枚数で数えていないと、ここで上限を超える
    const { hook } = setup();
    await act(async () => {
      const five = () =>
        Array.from({ length: 5 }, (_, i) => png(`${Math.random()}-${i}.png`));
      await Promise.all([
        hook.result.current.addFiles(five()),
        hook.result.current.addFiles(five()),
      ]);
    });
    await waitFor(() =>
      expect(hook.result.current.pending.length).toBeLessThanOrEqual(
        MAX_ATTACHMENTS_PER_MESSAGE,
      ),
    );
  });

  it("アップロードに失敗したら、その1枚だけ失敗として残る", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "容量オーバー" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const { hook } = setup();
    await act(async () => {
      await hook.result.current.addFiles([png("a.png")]);
    });
    await waitFor(() => {
      expect(hook.result.current.pending[0].status).toBe("error");
      expect(hook.result.current.pending[0].error).toContain("容量オーバー");
    });
  });
});

describe("生成画像の取り込み", () => {
  it("アップロードせずにそのまま添付できる", async () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.attachGeneratedImages([
        { id: "gen-1", mimeType: "image/png", name: "図", size: 10 },
      ]);
    });
    await waitFor(() => {
      expect(hook.result.current.pending[0].id).toBe("gen-1");
      expect(hook.result.current.pending[0].status).toBe("ready");
    });
    // 実体はR2にあるので通信は起きない
    expect(uploaded).toBe(0);
  });

  it("同じものを二重に足さない", async () => {
    const { hook } = setup();
    const img = { id: "gen-1", mimeType: "image/png", name: "図", size: 10 };
    act(() => hook.result.current.attachGeneratedImages([img]));
    act(() => hook.result.current.attachGeneratedImages([img]));
    await waitFor(() => expect(hook.result.current.pending).toHaveLength(1));
  });
});

describe("添付を外す", () => {
  it("指定した1枚だけ消える", async () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.attachGeneratedImages([
        { id: "g1", mimeType: "image/png", name: "1", size: 1 },
        { id: "g2", mimeType: "image/png", name: "2", size: 1 },
      ]);
    });
    await waitFor(() => expect(hook.result.current.pending).toHaveLength(2));
    const target = hook.result.current.pending[0].localId;
    act(() => hook.result.current.removePending(target));
    await waitFor(() => {
      expect(hook.result.current.pending).toHaveLength(1);
      expect(hook.result.current.pending[0].id).toBe("g2");
    });
  });
});
