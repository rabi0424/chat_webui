import { describe, expect, it } from "vitest";
import { createRoutesStub, Outlet } from "react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouteError } from "../../app/components/RouteError";

/**
 * 読み込みに失敗したときの見え方。
 *
 * 例外の受け皿が root にしか無かったので、会話が見つからないだけで
 * **文書ごと差し替わり、サイドバーまで消えていた**。戻る導線が無く、
 * URL を打ち直すしか手が無い。受け皿を子のルート側に置き、差し替わるのは
 * シェルの中身だけにする。
 */
function renderWithError(status: number | null) {
  const Stub = createRoutesStub([
    {
      path: "/",
      // シェル役。ここが残ることを確かめたい
      Component: () => (
        <div>
          <nav>会話の一覧</nav>
          <Outlet />
        </div>
      ),
      children: [
        {
          path: "chat/:id",
          Component: () => <p>本来の中身</p>,
          ErrorBoundary: RouteError,
          loader: () => {
            if (status == null) throw new Error("通信が切れました");
            throw new Response("見つかりません", { status });
          },
        },
      ],
    },
  ]);
  return {
    ...render(<Stub initialEntries={["/chat/c1"]} />),
    user: userEvent.setup(),
  };
}

describe("読み込みに失敗したとき", () => {
  it("会話が無いときは、そう分かる文言が出る", async () => {
    renderWithError(404);
    expect(await screen.findByText("見つかりませんでした")).toBeTruthy();
  });

  /** これが直したかったところ。 */
  it("一覧は消えない", async () => {
    renderWithError(404);
    await screen.findByText("見つかりませんでした");
    expect(screen.getByText("会話の一覧")).toBeTruthy();
  });

  it("戻る導線が出る", async () => {
    renderWithError(404);
    expect(await screen.findByText("新規チャットへ")).toBeTruthy();
  });

  it("見つからないものには「取り直す」を出さない", async () => {
    renderWithError(404);
    await screen.findByText("見つかりませんでした");
    // 取り直しても見つからないので、押せる意味が無い
    expect(screen.queryByText("取り直す")).toBeNull();
  });

  it("通信の失敗なら「取り直す」を出す", async () => {
    renderWithError(null);
    expect(await screen.findByText("取り直す")).toBeTruthy();
  });

  it("500 なら状態コードを出す", async () => {
    renderWithError(500);
    expect(await screen.findByText(/500/)).toBeTruthy();
  });

  it("本来の中身は出ない", async () => {
    renderWithError(404);
    await screen.findByText("見つかりませんでした");
    expect(screen.queryByText("本来の中身")).toBeNull();
  });
});
