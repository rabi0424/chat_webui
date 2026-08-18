import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import { THEME_COLOR_LIGHT, THEME_INIT_SCRIPT } from "./lib/theme";
import { ACCENT_INIT_SCRIPT } from "./lib/accent";
import { CHAT_FONT_INIT_SCRIPT } from "./lib/chat-font";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
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
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Chat" />
        {/* ハイドレーション前にテーマ・アクセント・文字サイズを適用してちらつきを防ぐ */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              THEME_INIT_SCRIPT + ACCENT_INIT_SCRIPT + CHAT_FONT_INIT_SCRIPT,
          }}
        />
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
        <pre className="mt-4 w-full overflow-x-auto rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
