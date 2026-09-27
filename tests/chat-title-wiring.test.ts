import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHELL_ROUTE_ID } from "../app/lib/conversation-title";

/**
 * 会話画面のタイトルをシェルの一覧から取る配線。
 *
 * 会話画面のローダーは同じ会話のままでは取り直さないので、サイドバーで
 * 名前を変えたことはシェルの一覧からしか届かない。一覧はルートIDの
 * 文字列で引いていて、外れても useRouteLoaderData が undefined を返す
 * だけ——画面には何も出ず、名前を変えてもヘッダーが古いまま残る。
 * DOM のテストは同じ定数でルートを組むので、この食い違いは拾えない。
 */
describe("会話画面のタイトルの配線", () => {
  it("SHELL_ROUTE_ID が routes.ts のシェルのルートと一致する", () => {
    const routes = readFileSync("app/routes.ts", "utf8");
    // routes.ts: layout("routes/shell.tsx", [...])
    const declared = routes.match(/layout\(\s*"([^"]+)"/)?.[1];
    expect(declared).toBeTruthy();
    expect(SHELL_ROUTE_ID).toBe(declared!.replace(/\.tsx?$/, ""));
  });

  it("シェルのローダーが会話一覧を conversations で返している", () => {
    const shell = readFileSync("app/routes/shell.tsx", "utf8");
    expect(shell).toMatch(/return \{\s*conversations,/);
  });
});
