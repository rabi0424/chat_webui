/**
 * 画面の中身だけを差し替えるエラー表示。
 *
 * 例外の受け皿が root にしか無かったので、会話が見つからない・読み込みに
 * 失敗した、といったときに**文書ごと差し替わり、サイドバーも消えていた**。
 * 戻る導線が無く、URL を打ち直すしか手が無い状態になる。
 *
 * 受け皿を子のルート側に置けば、差し替わるのはシェルの中身だけで済む。
 * 一覧は残るので、別の会話へ移って続きができる。
 */
import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router";
import { useRevalidator } from "react-router";
import { IconArrowLeft } from "./icons";

/** 状況に合わせた見出しと説明。 */
function describe(error: unknown): { title: string; detail: string } {
  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      return {
        title: "見つかりませんでした",
        detail:
          "削除されたか、別の端末で消された可能性があります。左の一覧から選び直してください。",
      };
    }
    return {
      title: `エラー ${error.status}`,
      detail: error.statusText || "読み込みに失敗しました。",
    };
  }
  return {
    title: "読み込めませんでした",
    detail:
      "通信が途切れたか、サーバー側で問題が起きています。少し待って試し直してください。",
  };
}

export function RouteError() {
  const error = useRouteError();
  const { title, detail } = describe(error);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-sm text-center">
        <h1 className="font-display text-lg font-bold">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          {detail}
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          {/* 見つからないものは取り直しても見つからないので、出さない */}
          {!notFound && (
            <button
              type="button"
              onClick={() => revalidator.revalidate()}
              disabled={revalidator.state !== "idle"}
              className="rounded-xl border border-line px-4 py-2 text-sm transition hover:bg-neutral-50 disabled:opacity-40 dark:hover:bg-white/5"
            >
              {revalidator.state === "idle" ? "取り直す" : "取り直しています…"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void navigate("/")}
            className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition hover:bg-accent/85"
          >
            <IconArrowLeft className="h-4 w-4" />
            新規チャットへ
          </button>
        </div>
        {import.meta.env.DEV && error instanceof Error && (
          <pre className="mt-6 max-h-60 overflow-auto rounded-lg bg-sunken p-3 text-left text-xs">
            <code>{error.stack ?? error.message}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
