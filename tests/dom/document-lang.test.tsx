import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { useDocumentLanguage } from "../../app/root";

/**
 * 文書に宣言する言語を、**親（root）から会話ルートのデータを引いて**決められるか。
 *
 * ここが今回の肝。`<html>` を描くのは root だが、言語の元になる本文を持って
 * いるのは会話ルートのローダーで、両者は別の階層にいる。引けていなければ
 * `useRouteLoaderData` は undefined を返すだけで、宣言は既定値のまま——
 * 画面には何も出ず、Safari の翻訳が出てこないという形でしか現れない。
 *
 * root の Layout そのものは `<Meta>` がフレームワークの文脈を要求するため
 * ここでは描けない。宣言の当て先（`<html lang={lang}>`）は
 * `tests/document-lang-wiring.test.ts` が見張る。
 */

function shownLanguage(
  messages: { content: string }[] | undefined,
  path = "/chat/c1",
): string {
  function Probe() {
    return <span data-testid="lang">{useDocumentLanguage()}</span>;
  }
  const router = createMemoryRouter(
    [
      {
        id: "root",
        path: "/",
        // root と同じ位置関係（親が子のデータを引く）にする
        Component: () => (
          <>
            <Probe />
            <Outlet />
          </>
        ),
        children: [
          {
            id: "routes/chat.$id",
            path: "chat/:id",
            Component: () => <p>本文</p>,
          },
          {
            id: "routes/settings",
            path: "settings",
            Component: () => <p>設定</p>,
          },
        ],
      },
    ],
    {
      initialEntries: [path],
      hydrationData: {
        loaderData: {
          root: null,
          ...(messages ? { "routes/chat.$id": { messages } } : {}),
        },
      },
    },
  );
  const view = render(<RouterProvider router={router} />);
  return view.getByTestId("lang").textContent ?? "";
}

const EN =
  "The quick brown fox jumps over the lazy dog. This reply is long enough to be judged as English text.";
const JA =
  "これは日本語の応答です。判定に足りるだけの長さがあり、漢字もカタカナも含んでいます。";

describe("文書に宣言する言語", () => {
  it("英語の会話を開いていれば en", () => {
    expect(shownLanguage([{ content: EN }])).toBe("en");
  });

  it("日本語の会話では ja", () => {
    expect(shownLanguage([{ content: JA }])).toBe("ja");
  });

  it("会話以外の画面では ja", () => {
    expect(shownLanguage(undefined, "/settings")).toBe("ja");
  });
});
