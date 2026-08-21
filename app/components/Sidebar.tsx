import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate, useParams, useRevalidator } from "react-router";
import type { ConversationRow, FolderRow, SearchResult } from "../lib/db.server";
import { ThemeToggle } from "./ThemeToggle";
import {
  SidebarProvider,
  type MenuTarget,
  type SidebarActions,
} from "./sidebar/context";
import {
  ConversationItem,
  FavoritesFolderItem,
  FolderItem,
} from "./sidebar/items";
import { FAVORITES_ID, usePrefetchOnVisible } from "./sidebar/shared";
import { useEscapeToClose } from "../lib/dismiss";
import {
  IconArrowLeft,
  IconBot,
  IconChartBar,
  IconCog,
  IconPencilSquare,
  IconPhoto,
  IconPlus,
  IconSearch,
  IconStar,
  IconStarSolid,
  IconX,
} from "./icons";
import {
  GLASS_ACCENT_BUTTON,
  GLASS_ICON_BUTTON,
  GLASS_PANEL,
} from "../lib/ui";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 検索結果内のヒット語を太字で表示する。 */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!text || terms.length === 0) return <>{text}</>;
  const re = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  // 捕捉グループ付きsplit: 奇数インデックスがヒット語
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <strong
            key={i}
            className="font-bold text-neutral-900 dark:text-neutral-50"
          >
            {part}
          </strong>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * 検索結果の1行。会話一覧と同じく、画面に入った時点でデータを先読みする
 * （usePrefetchOnVisible）。map の中ではフックを呼べないため独立させている。
 */
function SearchResultItem({
  r,
  terms,
  onNavigate,
}: {
  r: SearchResult;
  terms: string[];
  onNavigate?: () => void;
}) {
  const prefetchRef = usePrefetchOnVisible(r.id);
  return (
    <li ref={prefetchRef}>
      <NavLink
        to={`/chat/${r.id}`}
        prefetch="intent"
        onClick={onNavigate}
        className="block rounded-lg px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-900"
      >
        <span className="block truncate text-[0.9375rem] text-neutral-700 dark:text-neutral-200">
          <Highlight text={r.title} terms={terms} />
        </span>
        {r.snippet && (
          <span className="mt-0.5 block truncate text-[0.8125rem] text-neutral-400 dark:text-neutral-500">
            <Highlight text={r.snippet} terms={terms} />
          </span>
        )}
      </NavLink>
    </li>
  );
}

export function Sidebar({
  conversations,
  folders,
  unreadIds,
  onNavigate,
}: {
  conversations: ConversationRow[];
  folders: FolderRow[];
  /** 最新の未読状態。null のあいだは行の値を使う。 */
  unreadIds?: Set<string> | null;
  onNavigate?: () => void;
}) {
  /** 取得済みならそちらを正とする（開いて既読になった分も即座に消える）。 */
  const isUnread = (c: ConversationRow) =>
    unreadIds ? unreadIds.has(c.id) : c.unread === 1;
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const params = useParams();

  /** null = ルート表示、フォルダID = そのフォルダの階層を表示 */
  const [view, setView] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  /** フォルダ移動モーダルの対象会話ID */
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");

  // --- 検索（タイトル + 本文、"-語"で除外） ------------------------------
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 検索欄は畳んでおき、虫眼鏡を押したときだけ開く（一覧を広く使う）。 */
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);

  const openSearch = () => {
    setSearchOpen(true);
    // 描画後にフォーカスするとモバイルでもキーボードが上がる
    requestAnimationFrame(() => searchInput.current?.focus());
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error();
        const { results } = (await res.json()) as { results: SearchResult[] };
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [searchQuery]);

  const viewFolder =
    view && view !== FAVORITES_ID
      ? folders.find((f) => f.id === view) ?? null
      : null;
  const favoriteConversations = conversations.filter((c) => c.favorite === 1);

  /** 太字ハイライト対象の検索語（マイナス検索の除外語は含めない）。 */
  const highlightTerms = useMemo(
    () =>
      searchQuery
        .trim()
        .split(/[\s　]+/)
        .filter((t) => t && !t.startsWith("-")),
    [searchQuery],
  );

  const pinnedItems = useMemo(
    () =>
      [
        ...folders
          .filter((f) => f.pinned)
          .map((f) => ({ type: "folder" as const, folder: f })),
        ...conversations
          .filter((c) => c.pinned)
          .map((c) => ({ type: "conversation" as const, conversation: c })),
      ].sort((a, b) => {
        const ra = a.type === "folder" ? a.folder : a.conversation;
        const rb = b.type === "folder" ? b.folder : b.conversation;
        return ra.sort_order - rb.sort_order || ra.created_at - rb.created_at;
      }),
    [folders, conversations],
  );
  const unpinnedFolders = folders.filter((f) => !f.pinned);
  const rootConversations = conversations.filter(
    (c) => !c.pinned && c.folder_id == null,
  );
  const folderConversations = (fid: string) =>
    conversations.filter((c) => c.folder_id === fid);

  const refresh = () => revalidator.revalidate();

  // --- 会話操作 -----------------------------------------------------------

  async function patchConversation(id: string, body: Record<string, unknown>) {
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
    refresh();
  }

  function renameConversation(c: ConversationRow) {
    const name = prompt("新しい名前を入力してください", c.title);
    if (name?.trim()) void patchConversation(c.id, { title: name.trim() });
  }

  async function removeConversation(c: ConversationRow) {
    if (!confirm(`「${c.title}」を削除しますか？この操作は取り消せません。`)) {
      return;
    }
    await fetch(`/api/conversations/${c.id}`, { method: "DELETE" });
    if (params.id === c.id) navigate("/");
    refresh();
  }

  // --- フォルダ操作 -------------------------------------------------------

  async function patchFolder(id: string, body: Record<string, unknown>) {
    await fetch(`/api/folders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
    refresh();
  }

  function renameFolder(f: FolderRow) {
    const name = prompt("フォルダの新しい名前を入力してください", f.name);
    if (name?.trim()) void patchFolder(f.id, { name: name.trim() });
  }

  async function removeFolder(f: FolderRow) {
    if (
      !confirm(
        `フォルダ「${f.name}」を削除しますか？中の会話は削除されず、フォルダなしに戻ります。`,
      )
    ) {
      return;
    }
    await fetch(`/api/folders/${f.id}`, { method: "DELETE" });
    if (view === f.id) setView(null);
    refresh();
  }

  async function createFolderPrompt() {
    const name = prompt("新しいフォルダの名前を入力してください");
    if (!name?.trim()) return;
    await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    }).catch(() => {});
    refresh();
  }

  async function movePinned(type: "conversation" | "folder", id: string, direction: "up" | "down") {
    await fetch("/api/sidebar/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, id, direction }),
    }).catch(() => {});
    refresh();
  }

  const moveConv = moveTarget
    ? conversations.find((c) => c.id === moveTarget)
    : null;

  // 重ねて出しているものは、どれも Escape で閉じられるようにする。
  // 内側（メニュー）から順に、一度の Escape で1枚だけ閉じる
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeMove = useCallback(() => setMoveTarget(null), []);
  useEscapeToClose(moveConv != null, closeMove);
  useEscapeToClose(menu != null, closeMenu);

  const shortcutClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-xl px-3 py-2 text-[0.9375rem] ${
      isActive
        ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50"
        : "text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
    }`;


  /**
   * 行に配る操作一式。
   *
   * ここは毎回作り直す。中身の関数はどれも描画のたびに新しくなるので
   * memo しても同一にはならず、行は親と一緒に再描画される側だから、
   * 覚えておく利点が無い。
   */
  const actions: SidebarActions = {
    conversations,
    folders,
    menu,
    setMenu,
    isUnread,
    onNavigate,
    expanded,
    setExpanded,
    setView,
    conversationsIn: folderConversations,
    favorites: favoriteConversations,
    renameConversation,
    removeConversation,
    patchConversation,
    renameFolder,
    removeFolder,
    patchFolder,
    movePinned,
    openMoveDialog: (id) => {
      setNewFolderName("");
      setMoveTarget(id);
    },
  };

  return (
    <SidebarProvider value={actions}>
      <div
        className="relative flex h-full flex-col pt-[env(safe-area-inset-top)]"
        onClick={() => menu && setMenu(null)}
      >
        {/* ヘッダー: アプリ名と検索。検索は押したときだけ入力欄に変わる */}
        <div className="flex h-14 items-center gap-1 px-3">
          {searchOpen ? (
            <div className="relative flex-1 animate-pop">
              <input
                ref={searchInput}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeSearch();
                }}
                placeholder="検索（-語 で除外）"
                aria-label="会話を検索"
                className="w-full rounded-full border border-neutral-200 bg-neutral-50 py-2 pl-9 pr-9 text-base outline-none placeholder:text-neutral-400 focus:border-accent/60 sm:text-[0.9375rem] dark:border-neutral-700 dark:bg-neutral-900"
              />
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <button
                type="button"
                onClick={closeSearch}
                aria-label="検索を閉じる"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              >
                <IconX className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <>
              {/* アプリ名は「新規チャット」の入口も兼ねる（下の丸ボタンと同じ行き先） */}
              <NavLink
                to="/"
                prefetch="intent"
                onClick={onNavigate}
                title="新規チャット"
                className="min-w-0 flex-1 truncate rounded-lg px-2 py-1 text-xl font-semibold tracking-tight transition-colors hover:bg-neutral-100 active:scale-[0.98] dark:hover:bg-neutral-800"
              >
                Chat
              </NavLink>
              <button
                type="button"
                onClick={openSearch}
                aria-label="会話を検索"
                title="会話を検索"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-neutral-100 active:scale-95 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                <IconSearch className="h-5 w-5" />
              </button>
            </>
          )}
        </div>

        <div className="space-y-0.5 px-3 pb-1">
          <NavLink
            to="/bots"
            prefetch="intent"
            onClick={onNavigate}
            className={shortcutClass}
          >
            <IconBot className="h-4 w-4" />
            ボット管理
          </NavLink>
          <NavLink to="/images" prefetch="intent" onClick={onNavigate} className={shortcutClass}>
            <IconPhoto className="h-4 w-4" />
            画像
          </NavLink>
          <NavLink to="/usage" prefetch="intent" onClick={onNavigate} className={shortcutClass}>
            <IconChartBar className="h-4 w-4" />
            使用量
          </NavLink>
        </div>

        {/* 下部の浮いたボタンに隠れないよう、一覧は余分に下を空ける */}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-24">
          {searchQuery.trim() ? (
            /* --- 検索結果 --- */
            <>
              <p className="px-3 pb-1 pt-1 text-xs font-medium text-neutral-400 dark:text-neutral-600">
                {searching
                  ? "検索中…"
                  : `検索結果 ${searchResults?.length ?? 0}件`}
              </p>
              <ul className="space-y-0.5">
                {(searchResults ?? []).map((r) => (
                  <SearchResultItem
                    key={r.id}
                    r={r}
                    terms={highlightTerms}
                    onNavigate={onNavigate}
                  />
                ))}
                {!searching && searchResults?.length === 0 && (
                  <li className="px-3 py-6 text-center text-[0.8125rem] text-neutral-400 dark:text-neutral-600">
                    見つかりませんでした
                  </li>
                )}
              </ul>
            </>
          ) : view === FAVORITES_ID ? (
            /* --- お気に入りフォルダの階層表示 --- */
            <>
              <div className="mb-1 flex items-center gap-1 px-1">
                <button
                  type="button"
                  onClick={() => setView(null)}
                  aria-label="戻る"
                  className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                >
                  <IconArrowLeft className="h-4 w-4" />
                </button>
                <span className="flex items-center gap-1.5 truncate text-[0.9375rem] font-medium">
                  <IconStarSolid className="h-4 w-4 shrink-0 text-neutral-500 dark:text-white" />
                  お気に入り
                </span>
              </div>
              <ul className="space-y-0.5">
                {favoriteConversations.length === 0 && (
                  <li className="px-3 py-6 text-center text-[0.8125rem] leading-relaxed text-neutral-400 dark:text-neutral-600">
                    まだありません。
                    <br />
                    会話の「…」から
                    <br />
                    「お気に入りに追加」で入ります。
                  </li>
                )}
                {favoriteConversations.map((c) => (
                  <ConversationItem key={c.id} c={c} />
                ))}
              </ul>
            </>
          ) : viewFolder ? (
            /* --- フォルダ階層表示 --- */
            <>
              <div className="mb-1 flex items-center gap-1 px-1">
                <button
                  type="button"
                  onClick={() => setView(null)}
                  aria-label="戻る"
                  className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                >
                  <IconArrowLeft className="h-4 w-4" />
                </button>
                <span className="truncate text-[0.9375rem] font-medium">
                  📁 {viewFolder.name}
                </span>
              </div>
              <ul className="space-y-0.5">
                {folderConversations(viewFolder.id).length === 0 && (
                  <li className="px-3 py-6 text-center text-[0.8125rem] text-neutral-400 dark:text-neutral-600">
                    このフォルダは空です
                  </li>
                )}
                {folderConversations(viewFolder.id).map((c) => (
                  <ConversationItem key={c.id} c={c} />
                ))}
              </ul>
            </>
          ) : (
            /* --- ルート表示 --- */
            <>
              {pinnedItems.length > 0 && (
                <>
                  <p className="px-3 pb-1 pt-2 text-xs font-medium text-neutral-400 dark:text-neutral-600">
                    ピン留め
                  </p>
                  <ul className="space-y-0.5">
                    {pinnedItems.map((it) =>
                      it.type === "folder" ? (
                        <FolderItem key={`f${it.folder.id}`} f={it.folder} />
                      ) : (
                        <ConversationItem
                          key={`c${it.conversation.id}`}
                          c={it.conversation}
                        />
                      ),
                    )}
                  </ul>
                </>
              )}

              <div className="flex items-center justify-between px-3 pb-1 pt-3">
                <p className="text-xs font-medium text-neutral-400 dark:text-neutral-600">
                  フォルダ
                </p>
                <button
                  type="button"
                  onClick={() => void createFolderPrompt()}
                  aria-label="フォルダを作成"
                  title="フォルダを作成"
                  className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
                >
                  <IconPlus className="h-4 w-4" />
                </button>
              </div>
              <ul className="space-y-0.5">
                {/* 常設。削除も名前の変更もできないので、常に先頭に置く */}
                <FavoritesFolderItem />
                {unpinnedFolders.map((f) => (
                  <FolderItem key={f.id} f={f} />
                ))}
              </ul>

              <p className="px-3 pb-1 pt-3 text-xs font-medium text-neutral-400 dark:text-neutral-600">
                会話
              </p>
              {rootConversations.length === 0 && pinnedItems.length === 0 && (
                <p className="px-3 py-4 text-center text-[0.8125rem] text-neutral-400 dark:text-neutral-600">
                  まだ会話はありません
                </p>
              )}
              <ul className="space-y-0.5">
                {rootConversations.map((c) => (
                  <ConversationItem key={c.id} c={c} />
                ))}
              </ul>
            </>
          )}
        </nav>

        {/*
          下部に浮かべるバー。一覧の上に重ね、背景をぼかしたガラスの
          ボタンで「新規チャット・テーマ・設定」を常に手の届く位置に置く。
          バー自体はタップを通し（pointer-events-none）、ボタンだけが拾う。
        */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-white via-white/60 to-transparent pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-16 dark:from-neutral-950 dark:via-neutral-950/60">
          <div className="pointer-events-auto flex items-center gap-2 px-3">
            <NavLink
              to="/"
              prefetch="intent"
              onClick={onNavigate}
              title="新規チャット"
              className={`flex min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 py-3 text-[0.9375rem] font-semibold transition active:scale-95 ${GLASS_ACCENT_BUTTON}`}
            >
              <IconPencilSquare className="h-4.5 w-4.5 shrink-0" />
              新規チャット
            </NavLink>
            <ThemeToggle />
            <NavLink
              to="/settings"
              prefetch="intent"
              onClick={onNavigate}
              aria-label="設定"
              title="設定"
              className={({ isActive }) =>
                `${GLASS_ICON_BUTTON} ${isActive ? "text-accent-ink" : ""}`
              }
            >
              <IconCog className="h-5 w-5" />
            </NavLink>
          </div>
        </div>

        {/*
          フォルダ移動モーダル。Sidebarのルートが relative なので、ここは
          fixed ではなく absolute inset-0 でサイドバーの領域だけに重ねる
          （fixed だと画面全体を基準に中央寄せされ、幅の狭いサイドバーから
          見て右に偏った位置に出てしまう）。他のガラス面と揃え GLASS_PANEL。
        */}
        {moveConv && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm animate-fade"
            onClick={() => setMoveTarget(null)}
          >
            <div
              className={`w-full max-w-sm rounded-2xl p-4 animate-pop ${GLASS_PANEL}`}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="mb-3 text-sm font-semibold">
                「{moveConv.title}」をフォルダへ移動
              </p>
              <div className="max-h-60 space-y-1 overflow-y-auto">
                {/*
                  お気に入りは実フォルダではないので「移動」ではなく印の
                  付け外し。フォルダに入れたままお気に入りにもできる。
                */}
                <button
                  type="button"
                  onClick={() => {
                    void patchConversation(moveConv.id, {
                      favorite: moveConv.favorite !== 1,
                    });
                    setMoveTarget(null);
                  }}
                  className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-white/10"
                >
                  {moveConv.favorite === 1 ? (
                    <IconStarSolid className="h-4 w-4 shrink-0 text-neutral-500 dark:text-white" />
                  ) : (
                    <IconStar className="h-4 w-4 shrink-0 text-neutral-400" />
                  )}
                  {moveConv.favorite === 1
                    ? "お気に入りから外す"
                    : "お気に入りに追加"}
                </button>
                <div
                  role="separator"
                  className="my-1 border-t border-neutral-200/70 dark:border-white/10"
                />
                {moveConv.folder_id != null && (
                  <button
                    type="button"
                    onClick={() => {
                      void patchConversation(moveConv.id, { folderId: null });
                      setMoveTarget(null);
                    }}
                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-white/10"
                  >
                    フォルダから出す
                  </button>
                )}
                {folders.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    disabled={moveConv.folder_id === f.id}
                    onClick={() => {
                      void patchConversation(moveConv.id, { folderId: f.id });
                      setMoveTarget(null);
                    }}
                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-200 dark:hover:bg-white/10"
                  >
                    📁 {f.name}
                  </button>
                ))}
                {folders.length === 0 && (
                  <p className="px-3 py-2 text-xs text-neutral-400">
                    フォルダはまだありません。下で作成できます。
                  </p>
                )}
              </div>
              <div className="mt-3 flex gap-2">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="新しいフォルダ名"
                  className="min-w-0 flex-1 rounded-lg border border-neutral-200/80 bg-white/60 px-3 py-2 text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
                />
                <button
                  type="button"
                  disabled={!newFolderName.trim()}
                  onClick={async () => {
                    const res = await fetch("/api/folders", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: newFolderName.trim() }),
                    });
                    if (res.ok) {
                      const { folder } = (await res.json()) as { folder: FolderRow };
                      await patchConversation(moveConv.id, { folderId: folder.id });
                    }
                    setMoveTarget(null);
                  }}
                  className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:bg-accent/85 disabled:opacity-30"
                >
                  作成して移動
                </button>
              </div>
              <div className="mt-2 text-right">
                <button
                  type="button"
                  onClick={() => setMoveTarget(null)}
                  className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/10"
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </SidebarProvider>
  );
}
