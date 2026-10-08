import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { createRoutesStub, Outlet, useLocation } from "react-router";
import userEvent from "@testing-library/user-event";
import Favorites from "../../app/routes/favorites";
import { SHELL_ROUTE_ID } from "../../app/lib/conversation-title";
import { conv, folder } from "./helpers/sidebar-harness";
import type { ConversationListRow, FolderRow } from "../../app/lib/db.server";

/**
 * お気に入りの専用ページ。
 *
 * サイドバーの200件の壁の外も含めた全件を、日付の見出しで区切って出す。
 * 外す操作は行を先に消し、失敗したら戻して伝える。
 */
interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[];
let failStatus: number | null;
/** シェルのローダーが呼ばれた回数（外した後に取り直したか）。 */
let shellLoads: number;

beforeEach(() => {
  calls = [];
  failStatus = null;
  shellLoads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    let body: unknown = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ method: init?.method ?? "GET", path, body });
    if (failStatus != null) {
      return new Response(JSON.stringify({ error: "失敗" }), {
        status: failStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

function Here() {
  return <span data-testid="here">{useLocation().pathname}</span>;
}

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function renderFavorites(
  conversations: ConversationListRow[],
  folders: FolderRow[] = [],
) {
  const Stub = createRoutesStub([
    {
      id: SHELL_ROUTE_ID,
      path: "/",
      loader: () => {
        shellLoads++;
        return { folders };
      },
      // シェル役。ページは useOutletContext でモデル名などを受け取る
      Component: () => (
        <Outlet
          context={{
            models: [{ id: "openai/gpt-4o-mini", name: "GPT-4o mini" }],
            openSidebar: () => {},
          }}
        />
      ),
      children: [
        {
          path: "favorites",
          Component: () => (
            <Favorites
              loaderData={{ conversations, now: NOW }}
              params={{}}
              matches={[] as never}
            />
          ),
        },
        { path: "chat/:id", Component: Here },
      ],
    },
  ]);
  render(<Stub initialEntries={["/favorites"]} />);
  return userEvent.setup();
}

describe("お気に入りのページ", () => {
  it("全件を日付の見出しで区切って並べ、モデル名とフォルダ名を添える", async () => {
    renderFavorites(
      [
        conv("c1", "今日の相談", { favorite: 1, updated_at: NOW }),
        conv("c2", "先週の相談", {
          favorite: 1,
          updated_at: NOW - 3 * DAY,
          folder_id: "f1",
        }),
      ],
      [folder("f1", "仕事")],
    );
    expect(await screen.findByText("今日の相談")).toBeTruthy();
    expect(screen.getByText("先週の相談")).toBeTruthy();
    // 見出しは「今日」と「過去7日」。「昨日」は無い（該当する行が無い）
    expect(screen.getByRole("heading", { name: "今日" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "過去7日" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "昨日" })).toBeNull();
    // モデルは ID ではなく名前。フォルダ名も出る
    expect(screen.getAllByText("GPT-4o mini")).toHaveLength(2);
    expect(screen.getByText("仕事")).toBeTruthy();
    // 件数
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("2");
  });

  it("行を押すとその会話が開く", async () => {
    const user = renderFavorites([
      conv("c1", "今日の相談", { favorite: 1, updated_at: NOW }),
    ]);
    await user.click(await screen.findByText("今日の相談"));
    expect(screen.getByTestId("here").textContent).toBe("/chat/c1");
  });

  it("1つも無ければ、空だと分かる", async () => {
    renderFavorites([]);
    expect(await screen.findByText("お気に入りはまだありません")).toBeTruthy();
  });

  it("題名で絞り込める", async () => {
    const user = renderFavorites([
      conv("c1", "旅行の計画", { favorite: 1, updated_at: NOW }),
      conv("c2", "仕事の相談", { favorite: 1, updated_at: NOW }),
    ]);
    await screen.findByText("旅行の計画");
    await user.type(screen.getByLabelText("お気に入りを題名で絞り込む"), "旅行");
    expect(screen.getByText("旅行の計画")).toBeTruthy();
    expect(screen.queryByText("仕事の相談")).toBeNull();
    // 何も当たらないときは、空ではなく「見つからない」
    await user.clear(screen.getByLabelText("お気に入りを題名で絞り込む"));
    await user.type(screen.getByLabelText("お気に入りを題名で絞り込む"), "存在しない");
    expect(screen.getByText("見つかりませんでした")).toBeTruthy();
    expect(screen.queryByText("お気に入りはまだありません")).toBeNull();
  });

  it("外すと押した時点で行が消え、書けたら一覧を取り直す", async () => {
    const user = renderFavorites([
      conv("c1", "外す会話", { favorite: 1, updated_at: NOW }),
      conv("c2", "残る会話", { favorite: 1, updated_at: NOW }),
    ]);
    await screen.findByText("外す会話");
    const before = shellLoads;
    await user.click(screen.getByLabelText("「外す会話」をお気に入りから外す"));
    expect(screen.queryByText("外す会話")).toBeNull();
    expect(screen.getByText("残る会話")).toBeTruthy();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/conversations/c1");
    expect(patch?.body).toEqual({ favorite: false });
    // 書けたらシェルごと取り直す（サイドバーの件数が揃う）
    await waitFor(() => expect(shellLoads).toBeGreaterThan(before));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("1");
  });

  it("外せなかったら、行を戻して伝える", async () => {
    failStatus = 500;
    const user = renderFavorites([
      conv("c1", "外す会話", { favorite: 1, updated_at: NOW }),
    ]);
    await screen.findByText("外す会話");
    await user.click(screen.getByLabelText("「外す会話」をお気に入りから外す"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("外す会話")).toBeTruthy();
    expect(
      within(screen.getByRole("alert")).getByText(/外せませんでした/),
    ).toBeTruthy();
  });
});
