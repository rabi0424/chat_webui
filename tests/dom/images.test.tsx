import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

/** そのタイル（画面外を飛ばす指定が付いた器）。 */
function tileOf(id: string): HTMLElement {
  return screen
    .getByAltText(`${id} の依頼文`)
    .closest("[class*='content-visibility']") as HTMLElement;
}

/** そのタイルの「…」を開く。 */
async function openMenu(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(within(tileOf(id)).getByLabelText("この画像の操作"));
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

/**
 * 画面外のマスを飛ばす指定（content-visibility）と、マス自身が正方形で
 * あることの結び付き。
 *
 * content-visibility が効いているあいだ、中身は**大きさの計算から外れる**
 * （size containment）。高さを中の画像から取っていると、画面外に出た
 * 瞬間にマスが潰れ、一覧全体が飛び跳ねる。正方形はマスの側で宣言して
 * おかないといけない——片方だけ動かしても型もテストも通ってしまうので、
 * 結び付きをここで見張る。
 */
describe("画面外のマスを飛ばす指定", () => {
  it("飛ばす指定と正方形は、同じ要素に付いている", () => {
    renderImages([image("i1")]);
    const tile = screen
      .getByAltText("i1 の依頼文")
      .closest("[class*='content-visibility']");
    expect(tile).not.toBeNull();
    expect(tile!.className).toMatch(/\baspect-square\b/);
  });

  it("大きさを中の画像から取っていない", () => {
    renderImages([image("i1")]);
    // 画像側に縦横比を持たせると、飛ばされた瞬間に潰れる
    expect(screen.getByAltText("i1 の依頼文").className).not.toMatch(
      /\baspect-/,
    );
  });
});

/**
 * 「…」のメニューは、マスの中に置いてはいけない。
 *
 * マスには画面外を飛ばす指定（content-visibility）が付いており、これは
 * paint containment を伴う——**はみ出したぶんは描かれずに消える**。
 * しかもマスはスマホで画面の1/3、デスクトップで1/6の幅しかないので、
 * 176px のメニューは必ずはみ出す。実際、右側が切り取られて読めない板に
 * なっていた。器の外（body 直下）へ出し、ボタンの位置に合わせて置く。
 *
 * 「切り取られている」ことは jsdom には映らない（レイアウトが無い）ので、
 * **どこに置かれているか**を見張る。
 */
describe("「…」のメニュー", () => {
  it("メニューはマスの外に描く（マスは中身を切り取るため）", async () => {
    const { user } = renderImages([image("i1")]);
    await openMenu(user, "i1");

    const item = screen.getByRole("menuitem", { name: "原寸で表示" });
    expect(tileOf("i1").contains(item)).toBe(false);
    // 「マスの中に無い」だけでは、開いていないときも通ってしまう
    expect(document.body.contains(item)).toBe(true);
    expect(item.closest("[role='menu']")).not.toBeNull();
  });

  it("画面の座標で置く（器に合わせた絶対配置にしない）", async () => {
    const { user } = renderImages([image("i1")]);
    await openMenu(user, "i1");

    const panel = screen
      .getByRole("menuitem", { name: "原寸で表示" })
      .closest("[role='menu']") as HTMLElement;
    expect(panel.className).toMatch(/\bfixed\b/);
    // 置き場所が決まっていること（決めそこねると画面の左上に貼り付く）
    expect(panel.style.left).not.toBe("");
    expect(panel.style.top).not.toBe("");
  });

  it("開いているあいだ、「…」は消えない", async () => {
    const { user } = renderImages([image("i1")]);
    const button = within(tileOf("i1")).getByLabelText("この画像の操作");
    // ふだんはマスにポインタを載せたときだけ出る
    expect(button.className).toMatch(/\bopacity-0\b/);

    await user.click(button);
    // メニューはマスの外に居るので、そちらへポインタを移すとマスの
    // ホバーが外れる。開いているあいだは出したままにしておく
    expect(button.className).not.toMatch(/\bopacity-0\b/);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("メニューからお気に入りを付け外しできる", async () => {
    const { user } = renderImages([image("i1")]);
    await openMenu(user, "i1");
    await user.click(screen.getByRole("menuitem", { name: "お気に入りに追加" }));

    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      favorite: true,
    });
    // 押したらメニューは閉じ、マスには★が付く
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(within(tileOf("i1")).getByLabelText("お気に入り")).toBeTruthy();
  });

  it("メニューから原寸表示を開ける", async () => {
    const { user } = renderImages([image("i1")]);
    await openMenu(user, "i1");
    await user.click(screen.getByRole("menuitem", { name: "原寸で表示" }));

    expect(screen.getByAltText("添付画像")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
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
    await openMenu(user, "i2");
    await user.click(screen.getByRole("menuitem", { name: "会話を開く" }));

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

/**
 * 拡大表示のまま隣の画像へ移る。
 *
 * 一覧へ戻ってから次のマスを押す、を繰り返すのは見比べるときに重い。
 * 左右に払う（マウスならドラッグ、キーボードなら ← → ）と隣へ移る。
 *
 * 払いは「閉じる」「拡大する」と同じ指の操作から見分けている。短い動きは
 * タップ（＝閉じる）、縦向きは払いにしない、端では戻すだけ——ここが崩れると
 * 見比べている最中に画面が閉じたり、行き止まりで空振りしたりする。
 */
describe("拡大表示を左右に払う", () => {
  const three = [image("i1"), image("i2"), image("i3")];

  /** いま開いている画像（帯に出ている依頼文で見分ける）。 */
  function openedId(): string | null {
    for (const id of ["i1", "i2", "i3"]) {
      if (screen.queryByText(`${id} の依頼文`)) return id;
    }
    return null;
  }

  /** 拡大表示の上を払う。dx が負なら左へ（＝次へ）。 */
  function swipe(dx: number, dy = 0) {
    const overlay = screen.getByAltText("添付画像").parentElement!;
    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(overlay, {
      pointerId: 1,
      clientX: 200 + dx / 2,
      clientY: 200 + dy / 2,
    });
    fireEvent.pointerMove(overlay, {
      pointerId: 1,
      clientX: 200 + dx,
      clientY: 200 + dy,
    });
    fireEvent.pointerUp(overlay, {
      pointerId: 1,
      clientX: 200 + dx,
      clientY: 200 + dy,
    });
  }

  it("左へ払うと次、右へ払うと前の画像になる", async () => {
    const { user } = renderImages(three);
    await openLightbox(user, "i1");
    expect(openedId()).toBe("i1");

    swipe(-120);
    expect(openedId()).toBe("i2");

    swipe(-120);
    expect(openedId()).toBe("i3");

    swipe(120);
    expect(openedId()).toBe("i2");
  });

  it("端では動かず、閉じもしない", async () => {
    const { user } = renderImages(three);
    await openLightbox(user, "i1");

    // 先頭で右へ（前は無い）
    swipe(120);
    expect(openedId()).toBe("i1");
    // 払いをタップとして扱うと、猶予のあとに閉じてしまう
    await new Promise((r) => setTimeout(r, 350));
    expect(openedId()).toBe("i1");
  });

  it("短い動きでは移らない（タップと見分けるため）", async () => {
    const { user } = renderImages(three);
    await openLightbox(user, "i1");
    swipe(-30);
    expect(openedId()).toBe("i1");
  });

  it("縦に流したぶんは払いにしない", async () => {
    const { user } = renderImages(three);
    await openLightbox(user, "i1");
    // 横に十分動いていても、縦のほうが大きければ払いではない
    swipe(-120, 300);
    expect(openedId()).toBe("i1");
  });

  it("矢印キーでも隣へ移る", async () => {
    const { user } = renderImages(three);
    await openLightbox(user, "i2");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(openedId()).toBe("i3");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(openedId()).toBe("i2");
  });
});
