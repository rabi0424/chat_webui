import { useMemo, useState } from "react";
import {
  Link,
  useOutletContext,
  useRevalidator,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/favorites";
import type { ShellContext } from "./shell";
import {
  listFavoriteConversations,
  type ConversationListRow,
  type FolderRow,
} from "../lib/db.server";
import { DATE_GROUP_LABELS, groupByDate } from "../lib/date-groups";
import { SHELL_ROUTE_ID } from "../lib/conversation-title";
import { bareModelName } from "../lib/constants";
import { invalidateChat } from "../lib/chat-cache";
import { TERSE_INPUT } from "../lib/ui";
import { EmptyState } from "../components/EmptyState";
import {
  IconFolder,
  IconMenu,
  IconSearch,
  IconStar,
  IconStarSolid,
  IconX,
} from "../components/icons";

export function meta() {
  return [{ title: "お気に入り - Chat" }];
}

/**
 * お気に入りの会話の全件。
 *
 * サイドバーの一覧は最新200件で切られていて、お気に入りはその外にも
 * ある。ここは件数に上限を置かず、専用の文で全件を引く。
 * 「今日・昨日」の基準はローダーが決める（サイドバーと同じ理由——
 * 描画のたびに時計を読むと、日付の境でハイドレーションが失敗する）。
 */
export async function loader() {
  return {
    conversations: await listFavoriteConversations(),
    now: Date.now(),
  };
}

/**
 * 日付。サーバー（UTC）とブラウザ（端末の時刻帯）でずれることがあるので、
 * 出す側で suppressHydrationWarning を付けてブラウザ側を正とする
 * （画像一覧と同じ）。
 */
function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** モデルIDは長いので、末尾の名前だけ出す。 */
function modelName(id: string | null): string {
  if (!id) return "";
  return bareModelName(id).split("/").pop() ?? id;
}

/** シェルのローダーのうち、この画面が読む分。 */
interface ShellFolders {
  folders?: FolderRow[];
}

function FavoriteRow({
  c,
  folderName,
  model,
  onRemove,
}: {
  c: ConversationListRow;
  folderName: string | null;
  model: string;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      {/* ボットで始めた会話はそのアイコン、それ以外は★ */}
      <span
        aria-hidden
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sunken text-lg"
      >
        {c.bot_icon ?? (
          <IconStarSolid className="h-4 w-4 text-neutral-500 dark:text-neutral-300" />
        )}
      </span>
      <Link
        to={`/chat/${c.id}`}
        prefetch="intent"
        className="min-w-0 flex-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className="block truncate text-[0.9375rem] font-medium">
          {c.title}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-2">
          <span className="truncate">{c.bot_name ?? model}</span>
          {folderName && (
            <>
              <span aria-hidden>·</span>
              <span className="flex min-w-0 items-center gap-0.5">
                <IconFolder className="h-3 w-3 shrink-0" />
                <span className="truncate">{folderName}</span>
              </span>
            </>
          )}
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums" suppressHydrationWarning>
            {formatDate(c.updated_at)}
          </span>
        </span>
      </Link>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`「${c.title}」をお気に入りから外す`}
        title="お気に入りから外す"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-500 hover:bg-black/[0.06] dark:text-neutral-300 dark:hover:bg-white/10"
      >
        <IconStarSolid className="h-4 w-4" />
      </button>
    </li>
  );
}

export default function Favorites({ loaderData }: Route.ComponentProps) {
  const { conversations, now } = loaderData;
  const { models, openSidebar } = useOutletContext<ShellContext>();
  const shell = useRouteLoaderData(SHELL_ROUTE_ID) as ShellFolders | undefined;
  const revalidator = useRevalidator();
  /** 外してまだ取り直しの着いていない会話（行を先に消す）。 */
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const folderNames = useMemo(
    () => new Map((shell?.folders ?? []).map((f) => [f.id, f.name])),
    [shell?.folders],
  );
  const modelNames = useMemo(
    () => new Map(models.map((m) => [m.id, m.name])),
    [models],
  );

  /** 題名で絞る（手元に全件あるので往復しない）。 */
  const terms = query
    .trim()
    .toLowerCase()
    .split(/[\s　]+/)
    .filter(Boolean);
  const visible = conversations.filter(
    (c) =>
      !removed.has(c.id) &&
      terms.every((t) => c.title.toLowerCase().includes(t)),
  );
  const groups = groupByDate(visible, (c) => c.updated_at, now);

  /**
   * お気に入りから外す。行は先に消し、失敗したら戻して伝える
   * （サイドバーの操作と同じ考え方——返事を待ってから消すと、押したのに
   * 残っているように見える）。
   */
  async function remove(c: ConversationListRow) {
    setRemoved((prev) => new Set(prev).add(c.id));
    setError(null);
    let ok: boolean;
    try {
      const res = await fetch(`/api/conversations/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite: false }),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (!ok) {
      setRemoved((prev) => {
        const next = new Set(prev);
        next.delete(c.id);
        return next;
      });
      setError(`「${c.title}」をお気に入りから外せませんでした`);
      return;
    }
    // 先読みの写しには favorite も入っている（Sidebar.patchConversation と同じ）
    invalidateChat(c.id);
    // 取り直すとサイドバーの件数も揃う（シェルのローダーも一緒に走る）
    revalidator.revalidate();
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-line px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="メニュー"
          className="grid h-11 w-11 -my-1 place-items-center rounded-lg text-ink-2 hover:bg-hover md:hidden"
        >
          <IconMenu className="h-5 w-5" />
        </button>
        <h1 className="px-1 text-[0.9375rem] font-semibold">
          お気に入り
          <span className="ml-1.5 text-xs font-normal tabular-nums text-ink-2">
            {conversations.length - removed.size}
          </span>
        </h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 pb-[max(env(safe-area-inset-bottom),1.5rem)] pt-4">
          {error && (
            <p
              role="alert"
              className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              {error}
            </p>
          )}

          {conversations.length === 0 ? (
            <div className="py-14">
              <EmptyState
                icon={<IconStar />}
                title="お気に入りはまだありません"
                description="会話の「…」から「お気に入りに追加」で、ここに集まります。"
              />
            </div>
          ) : (
            <>
              <div className="relative mb-4">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="題名で絞り込む"
                  aria-label="お気に入りを題名で絞り込む"
                  {...TERSE_INPUT}
                  className="w-full rounded-full border border-black/[0.08] bg-surface py-2 pl-9 pr-9 text-base outline-none placeholder:text-neutral-400 focus:border-accent/60 sm:text-[0.9375rem] dark:border-white/10"
                />
                <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="絞り込みを消す"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-neutral-400 hover:bg-black/[0.06] hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-300"
                  >
                    <IconX className="h-4 w-4" />
                  </button>
                )}
              </div>

              {visible.length === 0 && (
                <p className="px-3 py-10 text-center text-sm text-ink-2">
                  見つかりませんでした
                </p>
              )}

              {/*
                会話は「今日・昨日・…」で区切る。並びは更新順のままで、
                見出しを挟むだけ（サイドバーと同じ地図）。
              */}
              {groups.map(({ group, items }, i) => (
                <section key={`${group}-${i}`} className="mb-6">
                  <h2 className="mb-1.5 px-1 text-xs font-medium text-ink-2">
                    {DATE_GROUP_LABELS[group]}
                  </h2>
                  <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-raised">
                    {items.map((c) => (
                      <FavoriteRow
                        key={c.id}
                        c={c}
                        folderName={
                          c.folder_id ? (folderNames.get(c.folder_id) ?? null) : null
                        }
                        model={
                          (c.model_id && modelNames.get(c.model_id)) ||
                          modelName(c.model_id)
                        }
                        onRemove={() => void remove(c)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// 例外の受け皿はこのルートに置く。root に任せると文書ごと
// 差し替わり、サイドバーまで消えて戻る導線が無くなる
export { RouteError as ErrorBoundary } from "../components/RouteError";
