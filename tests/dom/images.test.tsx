import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { createRoutesStub, Outlet, useLocation } from "react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Images from "../../app/routes/images";
import type { GeneratedImageRow } from "../../app/lib/db.server";

/**
 * 画像一覧。
 *
 * 並べるのは隙間を詰めたタイルで、説明と操作は開いたとき（拡大表示）に
 * 出す。会話へ飛ぶときは、**その画像を返した枝**へ表示を移してから開く
 * ——何度も作り直した会話では、そうしないと最後に見ていた枝（別の
 * 依頼文で作った結果）が開き、どれがこの画像の元なのか辿れない。
 */
interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[];
let failPath: string | null;

beforeEach(() => {
  calls = [];
  failPath = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    let body: unknown = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ method: init?.method ?? "GET", path, body });
    if (failPath && path.includes(failPath)) {
      return new Response(JSON.stringify({ error: "失敗" }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true, images: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

function image(
  id: string,
  extra: Partial<GeneratedImageRow> = {},
): GeneratedImageRow {
  return {
    id,
    conversation_id: "c1",
    message_id: `m-${id}`,
    created_at: 1_700_000_000_000,
    favorite: 0,
    prompt: `${id} の依頼文`,
    title: "絵を描く会話",
    model_id: "poe:Imagen-4",
    ...extra,
  };
}

function renderImages(images: GeneratedImageRow[]) {
  const Stub = createRoutesStub([
    {
      path: "/",
      // シェル役。Images は useOutletContext でここの値を受け取る
      Component: () => <Outlet context={{ openSidebar: () => {} }} />,
      children: [
        {
          path: "images",
          Component: () => (
            <Images
              loaderData={{ images }}
              params={{}}
              matches={[] as never}
            />
          ),
        },
        { path: "chat/:id", Component: Here },
      ],
    },
  ]);
  const result = render(<Stub initialEntries={["/images"]} />);
  return { ...result, user: userEvent.setup() };
}

/** 遷移先を読めるようにしておく。 */
function Here() {
  const { pathname } = useLocation();
  return <span data-testid="here">{pathname}</span>;
}

/** 1枚目のタイルを開く。 */
async function openLightbox(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(screen.getByAltText(`${id} の依頼文`));
}

describe("タイルの並び", () => {
  it("説明はタイルに書かず、開いたときに出す", async () => {
    const { user } = renderImages([image("i1")]);
    // 一覧では説明の文字を出さない（絵として見渡せるようにするため）
    expect(screen.queryByText("i1 の依頼文")).toBeNull();

    await openLightbox(user, "i1");
    expect(screen.getByText("i1 の依頼文")).toBeTruthy();
  });

  it("タイルも拡大表示も角を丸めない", async () => {
    const { user } = renderImages([image("i1")]);
    const tile = screen.getByAltText("i1 の依頼文");
    expect(tile.closest("button")?.className).not.toMatch(/\brounded/);

    await openLightbox(user, "i1");
    expect(screen.getByAltText("添付画像").className).not.toMatch(/\brounded/);
  });
});

describe("会話へ戻る", () => {
  it("拡大表示から、その画像を作った枝を開く", async () => {
    const { user } = renderImages([image("i1")]);
    await openLightbox(user, "i1");
    await user.click(screen.getByRole("button", { name: "会話を開く" }));

    // 開く前に、その応答の枝へ表示を移す
    await waitFor(() => {
      expect(screen.getByTestId("here").textContent).toBe("/chat/c1");
    });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/conversations/c1/path");
    expect(post?.body).toEqual({ messageId: "m-i1" });
  });

  it("一覧の「…」からでも、同じ枝を開く", async () => {
    const { user } = renderImages([image("i1"), image("i2")]);
    const tile = screen
      .getByAltText("i2 の依頼文")
      .closest("div") as HTMLElement;
    await user.click(within(tile).getByLabelText("この画像の操作"));
    await user.click(screen.getByRole("button", { name: "会話を開く" }));

    await waitFor(() => {
      expect(screen.getByTestId("here").textContent).toBe("/chat/c1");
    });
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      messageId: "m-i2",
    });
  });

  it("枝を切り替えられなくても、会話は開く", async () => {
    failPath = "/path";
    const { user } = renderImages([image("i1")]);
    await openLightbox(user, "i1");
    await user.click(screen.getByRole("button", { name: "会話を開く" }));

    // 開けないより、最後に見ていた枝でも会話に着いたほうがまし
    await waitFor(() => {
      expect(screen.getByTestId("here").textContent).toBe("/chat/c1");
    });
  });

  it("会話が消えている画像には、開く導線を出さない", async () => {
    const { user } = renderImages([image("i1", { conversation_id: null })]);
    await openLightbox(user, "i1");
    expect(screen.queryByRole("button", { name: "会話を開く" })).toBeNull();
  });
});

describe("拡大表示の操作", () => {
  it("お気に入りはその場で切り替わる", async () => {
    const { user } = renderImages([image("i1")]);
    await openLightbox(user, "i1");
    await user.click(screen.getByLabelText("お気に入りに追加"));

    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      favorite: true,
    });
    // 開いたままの帯も切り替わる（閉じて開き直さなくても分かる）
    await waitFor(() => {
      expect(screen.getByLabelText("お気に入りを解除")).toBeTruthy();
    });
  });
});
