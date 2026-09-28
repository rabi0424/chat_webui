import { beforeEach, describe, expect, it } from "vitest";
import { useSyncExternalStore } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { Sidebar } from "../../app/components/Sidebar";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";
import type {
  ConversationListRow,
  FolderRow,
} from "../../app/lib/db.server";
import { answerRename, conv, folder } from "./helpers/sidebar-harness";

/**
 * サイドバーの操作は、返事を待たずに一覧へ映す。
 *
 * 以前は PATCH の返事を待ち、さらにシェルのローダーを取り直してから
 * 画面が変わった（往復2回）。名前の変更では、入力欄が閉じてから
 * 取り直しが着くまで**古い名前が出ていた**。
 *
 * ここでは返事を止めておける fetch と、あとから差し替えられる一覧
 * （ローダーの取り直しの代わり）で、途中の各時点の見え方を見る。
 * 返事を即座に返すスタブでは「待っているあいだ」が存在しないので、
 * 待ってから変わる作りでも通ってしまう。
 */

interface Loaded {
  conversations: ConversationListRow[];
  folders: FolderRow[];
}
let loaded: Loaded;
const listeners = new Set<() => void>();
/** シェルのローダーが取り直した一覧が着いた、の代わり。 */
function deliver(next: Loaded) {
  act(() => {
    loaded = next;
    for (const l of listeners) l();
  });
}

let held: { method: string; path: string; body: unknown; resolve: (ok: boolean) => void }[];
function installHeldFetch() {
  held = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    // 先読み（GET）は待たせない。書き込みだけを止める
    if (method === "GET") {
      return new Response("{}", { status: 404 });
    }
    return new Promise<Response>((resolve) => {
      held.push({
        method,
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        resolve: (ok) =>
          resolve(
            new Response(JSON.stringify(ok ? { ok: true } : { error: "失敗" }), {
              status: ok ? 200 : 500,
              headers: { "Content-Type": "application/json" },
            }),
          ),
      });
    });
  }) as typeof fetch;
}

/** 止めてある返事を返し、その後の取り直しと描画まで流す。 */
async function answer(i: number, ok: boolean) {
  await act(async () => {
    held[i].resolve(ok);
    for (let k = 0; k < 10; k++) await new Promise((r) => setTimeout(r, 0));
  });
}

function LiveSidebar() {
  const data = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => loaded,
  );
  return (
    <Sidebar
      conversations={data.conversations}
      folders={data.folders}
      unreadIds={null}
      generatingIds={null}
      now={1_700_000_000_000}
    />
  );
}

function renderLive(initial: Loaded) {
  loaded = initial;
  const Stub = createRoutesStub([
    {
      path: "/chat/:id",
      Component: () => (
        <ConfirmProvider>
          <LiveSidebar />
        </ConfirmProvider>
      ),
    },
  ]);
  render(<Stub initialEntries={["/chat/none"]} />);
  return userEvent.setup();
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, title: string) {
  const row = screen.getByText(title).closest("li") as HTMLElement;
  await user.click(within(row).getByLabelText("メニュー"));
}

/** その行が居る節の見出し（ピン留め・今日…）。 */
function sectionOf(title: string): string | null {
  const ul = screen.getByText(title).closest("ul");
  return ul?.previousElementSibling?.textContent ?? null;
}

beforeEach(() => {
  localStorage.clear();
  installHeldFetch();
});

describe("名前の変更", () => {
  it("欄を閉じた時点で新しい名前が出て、取り直した一覧が着くまで戻らない", async () => {
    const user = renderLive({ conversations: [conv("c1", "元の名前")], folders: [] });
    await openMenu(user, "元の名前");
    await user.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    await answerRename(user, "新しい名前");

    // 返事はまだ。それでも新しい名前が出ている
    expect(held).toHaveLength(1);
    expect(held[0].body).toEqual({ title: "新しい名前" });
    expect(screen.getByText("新しい名前")).toBeInTheDocument();
    expect(screen.queryByText("元の名前")).toBeNull();

    // 送る前に始まっていた取り直しが、古い名前のまま着いても戻らない
    deliver({ conversations: [conv("c1", "元の名前")], folders: [] });
    expect(screen.getByText("新しい名前")).toBeInTheDocument();

    // 書けた。取り直しの結果が描かれるまでのあいだも、古い名前には戻らない
    await answer(0, true);
    expect(screen.getByText("新しい名前")).toBeInTheDocument();
    expect(screen.queryByText("元の名前")).toBeNull();

    // 書いた後に読んだ一覧が着いた
    deliver({ conversations: [conv("c1", "新しい名前")], folders: [] });
    expect(screen.getByText("新しい名前")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("書けた後に着いた一覧が別の名前なら、そちらを出す（重ねたものは外れる）", async () => {
    const user = renderLive({ conversations: [conv("c1", "元の名前")], folders: [] });
    await openMenu(user, "元の名前");
    await user.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    await answerRename(user, "新しい名前");
    await answer(0, true);

    // 別の端末でさらに変えた名前。いつまでも手元の変更で上書きしない
    deliver({ conversations: [conv("c1", "別の端末の名前")], folders: [] });
    expect(screen.getByText("別の端末の名前")).toBeInTheDocument();
    expect(screen.queryByText("新しい名前")).toBeNull();
  });

  it("失敗したら元の名前に戻し、失敗したと伝える", async () => {
    const user = renderLive({ conversations: [conv("c1", "元の名前")], folders: [] });
    await openMenu(user, "元の名前");
    await user.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    await answerRename(user, "新しい名前");
    expect(screen.getByText("新しい名前")).toBeInTheDocument();

    await answer(0, false);
    expect(screen.getByText("元の名前")).toBeInTheDocument();
    expect(screen.queryByText("新しい名前")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("会話の更新に失敗しました");
  });

  it("フォルダの名前も同じ", async () => {
    const user = renderLive({ conversations: [], folders: [folder("f1", "仕事")] });
    await openMenu(user, "仕事");
    await user.click(screen.getByRole("menuitem", { name: "名前を変更" }));
    await answerRename(user, "しごと");
    expect(held[0].path).toBe("/api/folders/f1");
    expect(screen.getByText("しごと")).toBeInTheDocument();

    await answer(0, false);
    expect(screen.getByText("仕事")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("フォルダの更新に失敗しました");
  });
});

describe("ピン留め・お気に入り・フォルダへの移動", () => {
  it("ピン留めは押した時点でピン留めの節へ移り、失敗したら戻る", async () => {
    const user = renderLive({
      conversations: [conv("c1", "対象"), conv("c2", "隣")],
      folders: [],
    });
    expect(sectionOf("対象")).not.toBe("ピン留め");
    await openMenu(user, "対象");
    await user.click(screen.getByRole("menuitem", { name: "ピン留め" }));
    expect(held).toHaveLength(1);
    expect(sectionOf("対象")).toBe("ピン留め");
    // 隣は動かない（行ごと消えたのではない）
    expect(sectionOf("隣")).not.toBe("ピン留め");

    await answer(0, false);
    expect(sectionOf("対象")).not.toBe("ピン留め");
    expect(screen.queryByText("ピン留め")).toBeNull();
  });

  it("お気に入りは押した時点で印が付く", async () => {
    const user = renderLive({ conversations: [conv("c1", "対象")], folders: [] });
    await openMenu(user, "対象");
    await user.click(screen.getByRole("menuitem", { name: "お気に入りに追加" }));
    const row = screen.getByText("対象").closest("li") as HTMLElement;
    // 常設の「お気に入り」フォルダの件数が 1 になる
    const fav = screen.getByTitle("お気に入り（削除できない常設フォルダ）");
    expect(fav.textContent).toContain("1");
    expect(row.querySelector("a svg")).not.toBeNull();
  });

  it("フォルダへ移すと、押した時点で一覧のフォルダの外から消え、フォルダの件数が増える", async () => {
    const user = renderLive({
      conversations: [conv("c1", "対象"), conv("c2", "残る")],
      folders: [folder("f1", "仕事")],
    });
    await openMenu(user, "対象");
    await user.click(screen.getByRole("menuitem", { name: "フォルダへ移動…" }));
    await user.click(screen.getByRole("button", { name: "仕事" }));
    expect(held[0].body).toEqual({ folderId: "f1" });
    // フォルダ外の一覧から外れた（フォルダは畳んであるので行は見えない）
    expect(screen.queryByText("対象")).toBeNull();
    expect(screen.getByText("残る")).toBeInTheDocument();
    const folderRow = screen.getByText("仕事").closest("button") as HTMLElement;
    expect(folderRow.textContent).toContain("1");
  });

  it("ピン留めの上下移動も、押した時点で並びが変わる", async () => {
    const user = renderLive({
      conversations: [
        conv("c1", "一番目", { pinned: 1, sort_order: 1 }),
        conv("c2", "二番目", { pinned: 1, sort_order: 2 }),
      ],
      folders: [],
    });
    const titles = () =>
      within(screen.getByText("一番目").closest("ul") as HTMLElement)
        .getAllByRole("link")
        .map((a) => a.textContent);
    expect(titles()).toEqual(["一番目", "二番目"]);
    await openMenu(user, "二番目");
    await user.click(screen.getByRole("menuitem", { name: "上へ移動" }));
    expect(held[0].path).toBe("/api/sidebar/move");
    expect(titles()).toEqual(["二番目", "一番目"]);
  });

  it("端から先へは動かせないので送らない", async () => {
    const user = renderLive({
      conversations: [
        conv("c1", "一番目", { pinned: 1, sort_order: 1 }),
        conv("c2", "二番目", { pinned: 1, sort_order: 2 }),
      ],
      folders: [],
    });
    await openMenu(user, "一番目");
    await user.click(screen.getByRole("menuitem", { name: "上へ移動" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(held).toHaveLength(0);
    expect(screen.getByText("一番目")).toBeInTheDocument();
  });
});
