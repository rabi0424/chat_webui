import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import { THEME_COLOR_LIGHT } from "./lib/theme";
import { APPEARANCE_INIT_SCRIPT } from "./lib/appearance-init";
import { useAppearanceSync } from "./lib/appearance";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  // <html> に載せた見た目（テーマ等）は React の管理外なので、
  // 描き直しで消されても保存値から貼り直す（lib/appearance.ts）
  useAppearanceSync();
  return (
    // <html> の class / data-accent / style は下のインラインスクリプトと
    // lib/appearance.ts が持つ（Reactは描かない）。サーバーの出力と
    // 食い違うのは想定どおりなので、この要素だけ警告を止める
    <html lang="ja" suppressHydrationWarning>
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
        <pre className="mt-4 w-full overflow-x-auto rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
