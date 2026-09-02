import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NavLink, useNavigate, useParams, useRevalidator } from "react-router";
import type {
  ConversationListRow,
  FolderRow,
  SearchResult,
} from "../lib/db.server";
import {
  SidebarProvider,
  type MenuTarget,
  type SidebarActions,
} from "./sidebar/context";
import {
  ConversationItem,
  FavoritesFolderItem,
  FolderItem,
  RenameField,
  ROW_ACTIVE,
  ROW_IDLE,
} from "./sidebar/items";
import { FAVORITES_ID, usePrefetchOnVisible } from "./sidebar/shared";
import { useEscapeToClose } from "../lib/dismiss";
import {
  useExpandedFolders,
  writeExpandedFolders,
} from "../lib/persisted";
import { DATE_GROUP_LABELS, groupByDate } from "../lib/date-groups";
import { useConfirm } from "./ConfirmDialog";
import {
  IconArrowLeft,
  IconBot,
  IconChartBar,
  IconCog,
  IconFolder,
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
  TERSE_INPUT,
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
        className={`block rounded-lg px-3 py-2 ${ROW_IDLE}`}
      >
        <span className="block truncate text-[0.9375rem]">
          <Highlight text={r.title} terms={terms} />
        </span>
        {r.snippet && (
          <span className="mt-0.5 block truncate text-[0.8125rem] text-ink-3">
            <Highlight text={r.snippet} terms={terms} />
          </span>
        )}
      </NavLink>
    </li>
  );
}

/** 節の見出し。右端に操作（フォルダの＋）を置けるようにしておく。 */
function SectionLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-3">
      <p className="text-[11px] font-medium tracking-wide text-ink-2">
        {children}
      </p>
      {action}
    </div>
  );
}

/**
 * アプリの印。角丸の四角をアクセント色で塗る。アクセントを変えると
 * 一緒に変わるので、それだけで「自分のアプリ」に見える。
 */
function AppMark() {
  return (
    <span
      aria-hidden
      className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-gradient-to-br from-accent to-accent/70 text-accent-fg shadow-sm"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        className="h-3.5 w-3.5"
      >
        <path d="M5 7h14M5 12h9M5 17h6" />
      </svg>
    </span>
  );
}

export function Sidebar({
  conversations,
  folders,
  unreadIds,
  generatingIds,
  now,
  onNavigate,
}: {
  conversations: ConversationListRow[];
  folders: FolderRow[];
  /** 最新の未読状態。null のあいだは行の値を使う。 */
  unreadIds?: Set<string> | null;
  /** いま生成が走っている会話（タイトルを光らせる）。 */
  generatingIds?: Set<string> | null;
  /**
   * 「今日」「昨日」の基準になる時刻。ローダーが決めてサーバーとブラウザで
   * 同じ値を使う（描画のたびに時計を読むと、日付の境でサーバーの出力と
   * 食い違い、ハイドレーションが失敗して <html> の見た目が消える）。
   */
  now: number;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const params = useParams();
  const confirm = useConfirm();

  /**
   * 未読の印を出すか。取得済みの状態があればそちらを正とする
   * （開いて既読になった分も即座に消える）。
   *
   * ただし**いま開いている会話には出さない**。「成功するまで生成」は
   * 最初の成功が届いた時点で印を立てるようになった（全部揃うまで
   * 光らないのでは、別の画面から進み具合が分からない）ぶん、見ている
   * 会話には見ている最中ずっと印が付くことになる。既読にするのは
   * 生成を見届けたときなので、それまでの間を画面側で埋める。
   */
  const isUnread = (c: ConversationListRow) =>
    c.id !== params.id && (unreadIds ? unreadIds.has(c.id) : c.unread === 1);
  const isGenerating = (c: ConversationListRow) =>
    generatingIds ? generatingIds.has(c.id) : false;

  /** null = ルート表示、フォルダID = そのフォルダの階層を表示 */
  const [view, setView] = useState<string | null>(null);
  /*
    開いているフォルダは保存して持ち回る。スマホのドロワーは閉じるたびに
    外されるので、状態を中に持つと開き直すたびに畳まれていた。画面の中に
    一覧は2つある（デスクトップ用とドロワー用）ので、どちらで開いても揃う。
  */
  const expanded = useExpandedFolders();
  const toggleExpanded = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    writeExpandedFolders([...next]);
  };
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  /** 名前をその場で書き換えている行。 */
  const [renaming, setRenaming] = useState<MenuTarget | null>(null);
  /** 新しいフォルダの名前を打っている（見出しの＋を押した）。 */
  const [creatingFolder, setCreatingFolder] = useState(false);
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
  /** 検索の世代。返る順が投げた順とは限らないので、最新のものだけ使う。 */
  const searchSeq = useRef(0);
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
    // 打つのを止めた分は待つが、それでも要求は並びうる（前の語の
    // 検索が遅いと、後の語の結果が先に返る）。いちばん新しい語の
    // 結果だけを受け取る
    const seq = ++searchSeq.current;
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error();
        const { results } = (await res.json()) as { results: SearchResult[] };
        if (seq !== searchSeq.current) return;
        setSearchResults(results);
      } catch {
        if (seq !== searchSeq.current) return;
        setSearchResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 300);
    // 待っている途中で外れたら投げない。閉じた画面のために検索させると、
    // Workers のサブリクエストを1件ぶん無駄にする（監査 C-9）
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
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
  /**
   * サーバー側で描く行数の上限。
   *
   * サイドバーは全ページの土台なので、ここで描くものは**どの画面を
   * 開いても**サーバーのCPUとHTMLに乗る。会話200件（一覧の上限）を
   * そのまま描くと、実測で1件あたり約1.1KB・0.09ms——素の画面が
   * 24.5KB/10ms のところ、245KB/27ms になっていた。Workers のCPU上限は
   * 無料プランで1回の呼び出しにつき10msなので、サイドバーだけで
   * 使い切る。使い切ると Cloudflare がその呼び出しを打ち切り、
   * 「Error 1102 Worker exceeded resource limits」で画面ごと開かなくなる。
   *
   * 一画面に入るのはせいぜい20行なので、サーバーが返すのはそこまで。
   * 残りはブラウザに出てから足す（会話の一覧そのものはローダーの
   * データとして既にHTMLに載っているので、往復は増えない）。
   */
  const SSR_ROWS = 20;
  const [allRows, setAllRows] = useState(false);
  useEffect(() => {
    startTransition(() => setAllRows(true));
  }, []);
  /** 一覧を描くときに通す。サーバー側では先頭だけに切る。 */
  const rows = <T,>(list: T[]): T[] =>
    allRows ? list : list.slice(0, SSR_ROWS);

  const unpinnedFolders = folders.filter((f) => !f.pinned);
  const rootConversations = conversations.filter(
    (c) => !c.pinned && c.folder_id == null,
  );
  /** ルートの会話を「今日・昨日・…」でまとめたもの。並びは変えない。 */
  const rootGroups = useMemo(
    () =>
      groupByDate(
        allRows ? rootConversations : rootConversations.slice(0, SSR_ROWS),
        (c) => c.updated_at,
        now,
      ),
    // rootConversations は描画のたびに作り直されるが、中身は props 由来
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversations, allRows, now],
  );
  const folderConversations = (fid: string) =>
    conversations.filter((c) => c.folder_id === fid);

  const refresh = () => revalidator.revalidate();

  /**
   * 操作の失敗を伝える。
   *
   * これまでは fetch を .catch(() => {}) で握りつぶしていた。名前を変えた
   * つもりが変わっていない・消したつもりが残っている、という結果だけが
   * 残り、しかも一覧は取り直されるので**元に戻ったように見える**。
   * 何が起きたか分からないまま同じ操作を繰り返すことになる。
   */
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
    },
    [],
  );
  const fail = (what: string) => {
    setError(`${what}に失敗しました`);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 5000);
  };

  /** 送って、失敗したら伝える。成功・失敗どちらでも一覧は取り直す。 */
  const send = async (
    what: string,
    input: string,
    init: RequestInit,
  ): Promise<Response | null> => {
    try {
      const res = await fetch(input, init);
      if (!res.ok) {
        fail(what);
        return null;
      }
      setError(null);
      return res;
    } catch {
      fail(what);
      return null;
    } finally {
      refresh();
    }
  };

  // --- 会話操作 -----------------------------------------------------------

  async function patchConversation(id: string, body: Record<string, unknown>) {
    await send("会話の更新", `/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function removeConversation(c: ConversationListRow) {
    const ok = await confirm({
      title: `「${c.title}」を削除しますか？`,
      description:
        "会話とメッセージ、添付した画像が消えます。この操作は取り消せません。使用量の記録は残ります。",
      confirmLabel: "削除",
      destructive: true,
    });
    if (!ok) return;
    const res = await send("会話の削除", `/api/conversations/${c.id}`, {
      method: "DELETE",
    });
    // 消せていないのに画面だけ移ると、消えたように見えてしまう
    if (res && params.id === c.id) navigate("/");
  }

  // --- フォルダ操作 -------------------------------------------------------

  async function patchFolder(id: string, body: Record<string, unknown>) {
    await send("フォルダの更新", `/api/folders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function removeFolder(f: FolderRow) {
    const ok = await confirm({
      title: `フォルダ「${f.name}」を削除しますか？`,
      description: "中の会話は消えません。フォルダなしに戻ります。",
      confirmLabel: "削除",
      destructive: true,
    });
    if (!ok) return;
    const res = await send("フォルダの削除", `/api/folders/${f.id}`, {
      method: "DELETE",
    });
    if (res && view === f.id) setView(null);
  }

  /**
   * 名前の書き換えの確定。空・不変なら何も送らない（送っても一覧を
   * 取り直すだけで害は無いが、往復が無駄になる）。
   */
  function finishRename(target: MenuTarget, name: string | null) {
    setRenaming(null);
    if (name == null) return;
    if (target.type === "conversation") {
      const c = conversations.find((x) => x.id === target.id);
      if (!c || c.title === name) return;
      void patchConversation(c.id, { title: name });
    } else {
      const f = folders.find((x) => x.id === target.id);
      if (!f || f.name === name) return;
      void patchFolder(f.id, { name });
    }
  }

  async function createFolder(name: string | null) {
    setCreatingFolder(false);
    if (!name) return;
    await send("フォルダの作成", "/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }

  async function movePinned(type: "conversation" | "folder", id: string, direction: "up" | "down") {
    await send("並べ替え", "/api/sidebar/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, id, direction }),
    });
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
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-[0.9375rem] ${
      isActive ? ROW_ACTIVE : ROW_IDLE
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
    isGenerating,
    onNavigate,
    expanded,
    toggleExpanded,
    setView,
    conversationsIn: folderConversations,
    favorites: favoriteConversations,
    renaming,
    startRename: setRenaming,
    finishRename,
    removeConversation,
    patchConversation,
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
      {/*
        面は本文より1段沈める。Mac のサイドバー（灰の面）と同じ考えで、
        白い紙の本文と、その脇の一覧を面の差で分ける。境界線は要らない。
      */}
      <div
        className="relative flex h-full flex-col bg-sunken pt-[env(safe-area-inset-top)]"
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
                {...TERSE_INPUT}
                className="w-full rounded-full border border-black/[0.08] bg-surface py-2 pl-9 pr-9 text-base outline-none placeholder:text-neutral-400 focus:border-accent/60 sm:text-[0.9375rem] dark:border-white/10"
              />
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <button
                type="button"
                onClick={closeSearch}
                aria-label="検索を閉じる"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-neutral-400 hover:bg-black/[0.06] hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-300"
              >
                <IconX className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <>
              {/*
                アプリの名前。以前は「新規チャット」の入口を兼ねていたが、
                見えない入口は無いのと同じで、しかもタイトルを押して会話が
                消えた（ように見える）事故のもとになる。入口は下のドックに。
              */}
              <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
                <AppMark />
                <span className="font-display truncate text-lg font-bold tracking-tight">
                  Chat
                </span>
              </div>
              <button
                type="button"
                onClick={openSearch}
                aria-label="会話を検索"
                title="会話を検索"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-2 transition hover:bg-black/[0.06] active:scale-95 dark:hover:bg-white/10"
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
            ボット
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

        {/*
        操作の失敗。一覧の上に短いあいだ出す（黙って元に戻ると、
        何が起きたのか分からないまま同じ操作を繰り返すことになる）
      */}
      {error && (
        <div
          role="status"
          className="mx-3 mb-1 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 animate-pop dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="閉じる"
            className="shrink-0 rounded p-0.5 hover:bg-red-100 dark:hover:bg-red-900"
          >
            <IconX className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

        {/* 一覧。下のドックはレイアウトの一部なので、ここは末尾まで見える */}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {searchQuery.trim() ? (
            /* --- 検索結果 --- */
            <>
              <SectionLabel>
                {searching
                  ? "検索中…"
                  : `検索結果 ${searchResults?.length ?? 0}件`}
              </SectionLabel>
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
                  <li className="px-3 py-6 text-center text-[0.8125rem] text-ink-2">
                    見つかりませんでした
                  </li>
                )}
              </ul>
            </>
          ) : view === FAVORITES_ID ? (
            /* --- お気に入りフォルダの階層表示 --- */
            <>
              <div className="mb-1 flex items-center gap-1 px-1 pt-2">
                <button
                  type="button"
                  onClick={() => setView(null)}
                  aria-label="戻る"
                  className="rounded-lg p-1.5 text-ink-2 hover:bg-black/[0.06] dark:hover:bg-white/10"
                >
                  <IconArrowLeft className="h-4 w-4" />
                </button>
                <span className="flex items-center gap-1.5 truncate text-[0.9375rem] font-medium">
                  <IconStarSolid className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-300" />
                  お気に入り
                </span>
              </div>
              <ul className="space-y-0.5">
                {favoriteConversations.length === 0 && (
                  <li className="px-3 py-6 text-center text-[0.8125rem] leading-relaxed text-ink-2">
                    まだありません。
                    <br />
                    会話の「…」から
                    <br />
                    「お気に入りに追加」で入ります。
                  </li>
                )}
                {rows(favoriteConversations).map((c) => (
                  <ConversationItem key={c.id} c={c} />
                ))}
              </ul>
            </>
          ) : viewFolder ? (
            /* --- フォルダ階層表示 --- */
            <>
              <div className="mb-1 flex items-center gap-1 px-1 pt-2">
                <button
                  type="button"
                  onClick={() => setView(null)}
                  aria-label="戻る"
                  className="rounded-lg p-1.5 text-ink-2 hover:bg-black/[0.06] dark:hover:bg-white/10"
                >
                  <IconArrowLeft className="h-4 w-4" />
                </button>
                <span className="flex items-center gap-1.5 truncate text-[0.9375rem] font-medium">
                  <IconFolder className="h-4 w-4 shrink-0 text-ink-2" />
                  {viewFolder.name}
                </span>
              </div>
              <ul className="space-y-0.5">
                {folderConversations(viewFolder.id).length === 0 && (
                  <li className="px-3 py-6 text-center text-[0.8125rem] text-ink-2">
                    このフォルダは空です
                  </li>
                )}
                {rows(folderConversations(viewFolder.id)).map((c) => (
                  <ConversationItem key={c.id} c={c} />
                ))}
              </ul>
            </>
          ) : (
            /* --- ルート表示 --- */
            <>
              {pinnedItems.length > 0 && (
                <>
                  <SectionLabel>ピン留め</SectionLabel>
                  <ul className="space-y-0.5">
                    {rows(pinnedItems).map((it) =>
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

              <SectionLabel
                action={
                  <button
                    type="button"
                    onClick={() => setCreatingFolder(true)}
                    aria-label="フォルダを作成"
                    title="フォルダを作成"
                    className="rounded p-0.5 text-neutral-400 hover:bg-black/[0.06] hover:text-neutral-600 touch:p-2 dark:hover:bg-white/10"
                  >
                    <IconPlus className="h-4 w-4" />
                  </button>
                }
              >
                フォルダ
              </SectionLabel>
              <ul className="space-y-0.5">
                {/* 新しいフォルダ。＋を押すと空の行が現れて、その場で名前を打つ */}
                {creatingFolder && (
                  <li className="px-1 py-0.5">
                    <RenameField
                      initial=""
                      placeholder="新しいフォルダ"
                      label="新しいフォルダの名前"
                      onFinish={(name) => void createFolder(name)}
                    />
                  </li>
                )}
                {/* 常設。削除も名前の変更もできないので、常に先頭に置く */}
                <FavoritesFolderItem />
                {rows(unpinnedFolders).map((f) => (
                  <FolderItem key={f.id} f={f} />
                ))}
              </ul>

              {rootConversations.length === 0 && pinnedItems.length === 0 && (
                <>
                  <SectionLabel>会話</SectionLabel>
                  <p className="px-3 py-4 text-center text-[0.8125rem] text-ink-2">
                    まだ会話はありません
                  </p>
                </>
              )}
              {/*
                会話は「今日・昨日・過去7日…」の見出しで区切る。並びは
                最終更新順のままで、見出しを挟むだけ。200件の一覧に地図が
                できる。
              */}
              {rootGroups.map(({ group, items }, i) => (
                <div key={`${group}-${i}`}>
                  <SectionLabel>{DATE_GROUP_LABELS[group]}</SectionLabel>
                  <ul className="space-y-0.5">
                    {items.map((c) => (
                      <ConversationItem key={c.id} c={c} />
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </nav>

        {/*
          下のドック。「新規チャット」と設定を、指の届く位置に常に置く。
          以前は一覧の上に浮かせてグラデーションで末尾を隠していたが、
          いまはレイアウトの一部で、一覧はこの上で終わる（末尾まで見える）。
          テーマの切替は設定画面へ移し、ピルの幅を稼いだ。
        */}
        <div className="flex shrink-0 items-center gap-2 border-t border-black/[0.06] px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2.5 dark:border-white/[0.08]">
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
              <p className="font-display mb-3 text-sm font-bold">
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
                  className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-black/[0.05] dark:text-neutral-200 dark:hover:bg-white/10"
                >
                  {moveConv.favorite === 1 ? (
                    <IconStarSolid className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-300" />
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
                    className="block w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-black/[0.05] dark:text-neutral-200 dark:hover:bg-white/10"
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
                    className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-black/[0.05] disabled:opacity-40 dark:text-neutral-200 dark:hover:bg-white/10"
                  >
                    <IconFolder className="h-4 w-4 shrink-0 text-neutral-400" />
                    {f.name}
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
                  {...TERSE_INPUT}
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
                  className="rounded-lg px-3 py-1.5 text-sm text-ink-2 hover:bg-black/[0.05] dark:hover:bg-white/10"
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
