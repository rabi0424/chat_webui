import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import { THEME_COLOR_LIGHT } from "./lib/theme";
import { APPEARANCE_INIT_SCRIPT } from "./lib/appearance-init";
import { useAppearanceSync } from "./lib/appearance";
import { conversationLanguage } from "./lib/content-language";
import "./app.css";

/**
 * 会話ルートのID。`app/routes.ts` のモジュールパスから拡張子を除いたもの。
 *
 * 文字列で結ばれているので、会話ルートのファイル名を変えるとここが黙って
 * 外れる——`useRouteLoaderData` は見つからなければ undefined を返すだけで、
 * 画面には何も出ず、翻訳が出なくなるだけになる。
 * `tests/document-lang-wiring.test.ts` が routes.ts と突き合わせて見張る。
 */
const CHAT_ROUTE_ID = "routes/chat.$id";

/**
 * 文書に宣言する言語。
 *
 * 会話画面はサーバーが器だけを返すので（Error 1102 対策。§3.3）、読み込みが
 * 終わった時点でブラウザが見られる本文が無い。ここで `ja` と書いたままだと、
 * 英語の会話を開いても Safari は「日本語のページ」と判定し、翻訳が出てこない。
 * **本文はローダーのデータとして既に手元にある**ので、それを見て宣言を決める
 * （描いてから直すのでは、判定はもう済んでいて間に合わない）。
 */
export function useDocumentLanguage(): string {
  const data = useRouteLoaderData(CHAT_ROUTE_ID) as
    | { messages?: { content?: string }[] }
    | undefined;
  return conversationLanguage(data?.messages);
}

export function Layout({ children }: { children: React.ReactNode }) {
  // <html> に載せた見た目（テーマ等）は React の管理外なので、
  // 描き直しで消されても保存値から貼り直す（lib/appearance.ts）
  useAppearanceSync();
  const lang = useDocumentLanguage();
  return (
    // <html> の class / data-accent / style は下のインラインスクリプトと
    // lib/appearance.ts が持つ（Reactは描かない）。サーバーの出力と
    // 食い違うのは想定どおりなので、この要素だけ警告を止める
    <html lang={lang} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        {/* ステータスバー領域の色。初期スクリプトとapplyTheme()がテーマに合わせて書き換える */}
        <meta name="theme-color" content={THEME_COLOR_LIGHT} />
        {/*
          PWA（ホーム画面追加でアプリ風の全画面表示）。
          オフライン動作は要件外のため Service Worker は持たない。
          black-translucent でステータスバーの背後まで描画し（境界が消える）、
          はみ出しは各画面の safe-area パディングで吸収する。
        */}
        {/*
          見出しの書体（Zen Kaku Gothic New）。本文は system-ui のままで、
          見出し・ダイアログの題・使用量の数字にだけ当てる（app.css の
          --font-display）。読み込みが終わるまでは同系のシステム書体で
          描かれ、届いたら差し替わる（display=swap）。
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@500;700&display=swap"
        />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Chat" />
        {/* ハイドレーション前にテーマ・アクセント・文字サイズを適用してちらつきを防ぐ */}
        {/*
          CSP では nonce ではなく sha256 で許している（この要素は React
          Router の管理外なので nonce が撒かれない）。中身を変えるときは
          APPEARANCE_INIT_SCRIPT のほうを直すこと——ここで連結し直すと
          ハッシュが合わずに実行されなくなる。
        */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "エラー";
  let details = "予期しないエラーが発生しました。";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "エラー";
    details =
      error.status === 404
        ? "ページが見つかりませんでした。"
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="container mx-auto p-4 pt-16">
      <h1 className="text-2xl font-bold">{message}</h1>
      <p className="mt-2 text-neutral-600 dark:text-neutral-300">{details}</p>
      {stack && (
        <pre className="mt-4 w-full overflow-x-auto rounded-lg bg-sunken p-4 text-sm">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
