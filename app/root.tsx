import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import { THEME_INIT_SCRIPT } from "./lib/theme";
import { ACCENT_INIT_SCRIPT } from "./lib/accent";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        {/* ハイドレーション前にテーマ・アクセントを適用してちらつきを防ぐ */}
        <script
          dangerouslySetInnerHTML={{
            __html: THEME_INIT_SCRIPT + ACCENT_INIT_SCRIPT,
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
