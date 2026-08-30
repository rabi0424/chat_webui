import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  conversationLanguage,
  DEFAULT_DOCUMENT_LANGUAGE,
} from "../app/lib/content-language";

/**
 * 文書に宣言する言語（`<html lang>`）の配線。
 *
 * 会話画面はサーバーが器だけを返すので、読み込みが終わった時点で
 * ブラウザが見られる本文が無い。`ja` と宣言したままだと、英語の会話でも
 * Safari は「日本語のページ」と判定し、翻訳が出てこない。
 *
 * 結び付きが3つあり、どれも**外れても画面には何も出ない**:
 *   ① root.tsx が会話ルートのIDを文字列で指している
 *      → ルートのファイル名を変えると useRouteLoaderData が undefined を
 *        返すようになり、宣言が既定値へ黙って戻る
 *   ② <html lang> が固定値に戻される
 *   ③ 画面まわり（日本語）が `lang="ja"` と断っている
 *      → 外れると、英語の会話に混じった日本語のボタン名まで英語だと
 *        言うことになり、短い会話では Safari 自身の数えたほうが日本語へ
 *        振れて翻訳が出ない
 */

const root = readFileSync("app/root.tsx", "utf8");
const routes = readFileSync("app/routes.ts", "utf8");
const shell = readFileSync("app/routes/shell.tsx", "utf8");

describe("会話の言語を文書に宣言する配線", () => {
  it("root.tsx が指すルートIDが、routes.ts の会話ルートと一致する", () => {
    // routes.ts: route("chat/:id", "routes/chat.$id.tsx")
    const declared = routes.match(
      /route\(\s*"chat\/:id"\s*,\s*"([^"]+)"\s*\)/,
    )?.[1];
    expect(declared).toBeTruthy();
    // ルートIDはモジュールパスから拡張子を落としたもの
    const expectedId = declared!.replace(/\.tsx?$/, "");
    const usedId = root.match(/const CHAT_ROUTE_ID = "([^"]+)"/)?.[1];
    expect(usedId).toBe(expectedId);
  });

  it("<html lang> は固定値ではなく、求めた値を使っている", () => {
    expect(root).toMatch(/<html\s+lang=\{lang\}/);
    expect(root).not.toMatch(/<html\s+lang="/);
  });

  it("会話ルートのローダーが messages を返している（宣言の元になる）", () => {
    const chat = readFileSync("app/routes/chat.$id.tsx", "utf8");
    expect(chat).toMatch(/messages:\s*found\.path\.map/);
  });

  it("全画面の土台が、画面まわりを日本語だと断っている", () => {
    expect(shell).toMatch(/lang="ja"/);
  });

  it("やり取りの範囲が、そこで会話の言語へ宣言し直している", () => {
    // 土台の lang="ja" は入れ子で継がれるので、本文側で上書きしないと
    // 英語の会話まで日本語だと言ったままになる
    const list = readFileSync("app/components/chat/MessageList.tsx", "utf8");
    expect(list).toMatch(/lang=\{conversationLanguage\(messages\)\}/);
  });
});

describe("会話から宣言する言語を決める", () => {
  const EN =
    "The quick brown fox jumps over the lazy dog. This reply is long enough to be judged English.";
  const JA =
    "これは日本語の応答です。判定に足りるだけの長さがあり、ひらがなも漢字もカタカナも含んでいます。";

  it("英語の会話は en", () => {
    expect(conversationLanguage([{ content: "hi" }, { content: EN }])).toBe(
      "en",
    );
  });

  it("日本語の会話は既定のまま", () => {
    expect(conversationLanguage([{ content: JA }])).toBe(
      DEFAULT_DOCUMENT_LANGUAGE,
    );
  });

  it("会話を開いていないときは既定", () => {
    expect(conversationLanguage(undefined)).toBe(DEFAULT_DOCUMENT_LANGUAGE);
    expect(conversationLanguage([])).toBe(DEFAULT_DOCUMENT_LANGUAGE);
  });

  it("判定できない短い会話では既定", () => {
    expect(conversationLanguage([{ content: "ok" }])).toBe(
      DEFAULT_DOCUMENT_LANGUAGE,
    );
  });

  it("新しい発言から見る（走査の上限に達したら古い側は読まない）", () => {
    // 昔は日本語、最近は英語に切り替わった長い会話。新しい側だけで
    // 上限に達するので、古い日本語までは読まない
    const old = { content: "あ".repeat(10_000) };
    const recent = { content: EN.repeat(60) };
    expect(conversationLanguage([old, recent])).toBe("en");
    // 逆向き（昔は英語・最近は日本語）も、新しい側が勝つ
    expect(
      conversationLanguage([
        { content: EN.repeat(60) },
        { content: "あ".repeat(10_000) },
      ]),
    ).toBe("ja");
  });

  it("上限に収まる会話は、全体の割合で決まる", () => {
    // 短い日本語の問い + 長い英語の応答は en（読みたいのは英語のほう）
    expect(
      conversationLanguage([{ content: "これを説明して" }, { content: EN }]),
    ).toBe("en");
  });

  it("content が無い行が混じっても落ちない", () => {
    expect(
      conversationLanguage([{}, { content: undefined }, { content: EN }]),
    ).toBe("en");
  });
});
