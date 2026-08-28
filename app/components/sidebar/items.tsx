/**
 * サイドバーに並ぶ行。
 *
 * 会話・フォルダ・お気に入り、そしてそれぞれの「…」メニュー。
 *
 * これらは以前 Sidebar の関数の内側で定義していた。内側に置くと描画の
 * たびに別のコンポーネントとして扱われ、そのぶん DOM が作り直される
 * （先読みの監視も貼り直しになる）。外に出し、必要な操作は文脈から
 * 受け取る形にした。
 */
import { NavLink } from "react-router";
import type { ConversationListRow, FolderRow } from "../../lib/db.server";
import { useSidebar, type MenuTarget } from "./context";
import {
  IconChatBubble,
  IconChevronRight,
  IconEllipsis,
  IconStarSolid,
} from "../icons";
import { FAVORITES_ID, usePrefetchOnVisible } from "./shared";
import { GLASS_PANEL } from "../../lib/ui";

export function MenuButton({ target }: { target: MenuTarget }) {
  const { menu, setMenu } = useSidebar();
  const open = menu?.type === target.type && menu.id === target.id;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu(open ? null : target);
      }}
      aria-label="メニュー"
      className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-neutral-400 hover:bg-neutral-200 group-hover:block dark:hover:bg-neutral-700 [.menu-open&]:block touch:block touch:p-2.5"
    >
      <IconEllipsis className="h-4 w-4" />
    </button>
  );
}

export function MenuItems({ target }: { target: MenuTarget }) {
  const {
    conversations,
    folders,
    menu,
    setMenu,
    renameConversation,
    removeConversation,
    patchConversation,
    renameFolder,
    removeFolder,
    patchFolder,
    movePinned,
    openMoveDialog,
  } = useSidebar();
  if (!(menu?.type === target.type && menu.id === target.id)) return null;
  const itemClass =
    "block w-full rounded-lg px-3 py-2 text-left text-[0.9375rem] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-white/10";
  const close = () => setMenu(null);

  if (target.type === "conversation") {
    const c = conversations.find((x) => x.id === target.id);
    if (!c) return null;
    return (
      <div className={`absolute right-1 top-8 z-40 w-44 origin-top-right rounded-xl p-1 animate-pop ${GLASS_PANEL}`}>
        <button type="button" className={itemClass} onClick={() => { close(); renameConversation(c); }}>
          名前を変更
        </button>
        <button type="button" className={itemClass} onClick={() => { close(); void patchConversation(c.id, { favorite: c.favorite !== 1 }); }}>
          {c.favorite === 1 ? "お気に入りから外す" : "お気に入りに追加"}
        </button>
        <button type="button" className={itemClass} onClick={() => { close(); void patchConversation(c.id, { pinned: !c.pinned }); }}>
          {c.pinned ? "ピン留めを解除" : "ピン留め"}
        </button>
        {c.pinned === 1 && (
          <>
            <button type="button" className={itemClass} onClick={() => { close(); void movePinned("conversation", c.id, "up"); }}>
              ↑ 上へ移動
            </button>
            <button type="button" className={itemClass} onClick={() => { close(); void movePinned("conversation", c.id, "down"); }}>
              ↓ 下へ移動
            </button>
          </>
        )}
        <button type="button" className={itemClass} onClick={() => { close(); openMoveDialog(c.id); }}>
          フォルダへ移動…
        </button>
        <button
          type="button"
          className="block w-full rounded-lg px-3 py-2 text-left text-[0.9375rem] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/15"
          onClick={() => { close(); void removeConversation(c); }}
        >
          削除
        </button>
      </div>
    );
  }

  const f = folders.find((x) => x.id === target.id);
  if (!f) return null;
  return (
    <div className={`absolute right-1 top-8 z-40 w-44 origin-top-right rounded-xl p-1 animate-pop ${GLASS_PANEL}`}>
      <button type="button" className={itemClass} onClick={() => { close(); renameFolder(f); }}>
        名前を変更
      </button>
      <button type="button" className={itemClass} onClick={() => { close(); void patchFolder(f.id, { pinned: !f.pinned }); }}>
        {f.pinned ? "ピン留めを解除" : "ピン留め"}
      </button>
      {f.pinned === 1 && (
        <>
          <button type="button" className={itemClass} onClick={() => { close(); void movePinned("folder", f.id, "up"); }}>
            ↑ 上へ移動
          </button>
          <button type="button" className={itemClass} onClick={() => { close(); void movePinned("folder", f.id, "down"); }}>
            ↓ 下へ移動
          </button>
        </>
      )}
      <button
        type="button"
        className="block w-full rounded-lg px-3 py-2 text-left text-[0.9375rem] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/15"
        onClick={() => { close(); void removeFolder(f); }}
      >
        削除
      </button>
    </div>
  );
}

// --- 行レンダリング -----------------------------------------------------

export function ConversationItem({ c, indent = false }: { c: ConversationListRow; indent?: boolean }) {
  const { menu, isUnread, isGenerating, onNavigate } = useSidebar();
  const open = menu?.type === "conversation" && menu.id === c.id;
  const generating = isGenerating(c);
  const prefetchRef = usePrefetchOnVisible(c.id);
  return (
    <li ref={prefetchRef} className={`group relative ${open ? "menu-open" : ""} ${indent ? "ml-5" : ""}`}>
      {/* prefetch="intent": ホバー/タッチ開始でデータとJSを先読みし、遷移の待ちを隠す */}
      <NavLink
        to={`/chat/${c.id}`}
        prefetch="intent"
        onClick={onNavigate}
        className={({ isActive }) =>
          `flex items-center gap-1.5 rounded-lg py-2 pl-3 pr-8 text-[0.9375rem] ${
            isActive
              ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50"
              : "text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
          }`
        }
      >
        {/* 開いていないうちに応答が完成した会話の印。右端は「…」が使う */}
        {isUnread(c) && (
          <span
            aria-label="新しい応答があります"
            title="新しい応答があります"
            className="h-2 w-2 shrink-0 rounded-full bg-accent"
          />
        )}
        {/* ピン留めは見出しで分かるので、印ではなく会話のアイコンを添える */}
        {c.pinned === 1 && (
          <IconChatBubble className="h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
        )}
        {c.favorite === 1 && (
          <IconStarSolid
            className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-white"
          />
        )}
        {/*
          生成中は、タイトルの上を光の帯が流れる（.title-shimmer）。
          別の画面にいるあいだも「まだ動いている会話」が一目で分かる。
          文字そのものを塗り替えるので、行の高さも位置も変わらない。
        */}
        <span
          className={`min-w-0 truncate ${generating ? "title-shimmer" : ""}`}
          title={generating ? "生成中です" : undefined}
        >
          {c.title}
        </span>
        {/* 見た目だけでは支援技術に伝わらないので、状態は言葉でも置く */}
        {generating && <span className="sr-only">（生成中）</span>}
      </NavLink>
      <MenuButton target={{ type: "conversation", id: c.id }} />
      <MenuItems target={{ type: "conversation", id: c.id }} />
    </li>
  );
}

/**
 * 常設の「お気に入り」フォルダの行。
 *
 * 見た目は他のフォルダと揃えるが、「…」メニューは出さない
 * （名前の変更も削除もできないため、出すものが無い）。
 */
export function FavoritesFolderItem() {
  const { expanded, toggleExpanded, setView, favorites } = useSidebar();
  const isExpanded = expanded.has(FAVORITES_ID);
  const children = favorites;
  return (
    <li className="relative">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => toggleExpanded(FAVORITES_ID)}
          aria-label={isExpanded ? "折りたたむ" : "展開"}
          className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 touch:p-2.5 dark:hover:bg-neutral-800"
        >
          <IconChevronRight
            className={`h-3.5 w-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
        </button>
        <button
          type="button"
          onClick={() => setView(FAVORITES_ID)}
          title="お気に入り（削除できない常設フォルダ）"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-2 pl-1 pr-3 text-left text-[0.9375rem] text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          <IconStarSolid className="h-4 w-4 shrink-0 text-neutral-500 dark:text-white" />
          {/* 件数は名前と同じ行に置く。別のflex項目にすると
              items-center で箱の中央が揃い、小さい字だけ上にずれて見える */}
          <span className="min-w-0 flex-1 truncate">
            お気に入り
            <span className="ml-1.5 text-xs text-neutral-500 dark:text-neutral-400">
              {children.length}
            </span>
          </span>
        </button>
      </div>
      {isExpanded && (
        <ul className="mt-0.5 space-y-0.5">
          {children.length === 0 && (
            <li className="ml-5 px-3 py-1.5 text-[0.8125rem] text-neutral-500 dark:text-neutral-400">
              （まだありません）
            </li>
          )}
          {children.map((c) => (
            <ConversationItem key={c.id} c={c} indent />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FolderItem({ f }: { f: FolderRow }) {
  const { menu, expanded, toggleExpanded, setView, conversationsIn } =
    useSidebar();
  const open = menu?.type === "folder" && menu.id === f.id;
  const isExpanded = expanded.has(f.id);
  const children = conversationsIn(f.id);
  return (
    <li className={`group relative ${open ? "menu-open" : ""}`}>
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => toggleExpanded(f.id)}
          aria-label={isExpanded ? "折りたたむ" : "展開"}
          className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 touch:p-2.5 dark:hover:bg-neutral-800"
        >
          <IconChevronRight
            className={`h-3.5 w-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
        </button>
        <button
          type="button"
          onClick={() => setView(f.id)}
          className="min-w-0 flex-1 truncate rounded-lg py-2 pl-1 pr-8 text-left text-[0.9375rem] text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          <span aria-hidden className="mr-1.5">📁</span>
          {f.name}
          <span className="ml-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            {children.length}
          </span>
        </button>
      </div>
      <MenuButton target={{ type: "folder", id: f.id }} />
      <MenuItems target={{ type: "folder", id: f.id }} />
      {isExpanded && (
        <ul className="mt-0.5 space-y-0.5">
          {children.length === 0 && (
            <li className="ml-5 px-3 py-1.5 text-[0.8125rem] text-neutral-500 dark:text-neutral-400">
              （空のフォルダ）
            </li>
          )}
          {children.map((c) => (
            <ConversationItem key={c.id} c={c} indent />
          ))}
        </ul>
      )}
    </li>
  );
}
