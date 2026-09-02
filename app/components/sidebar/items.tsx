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
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router";
import type { ConversationListRow, FolderRow } from "../../lib/db.server";
import { useSidebar, type MenuTarget } from "./context";
import {
  IconArrowDown,
  IconArrowUp,
  IconChatBubble,
  IconChevronRight,
  IconEllipsis,
  IconFolder,
  IconStarSolid,
} from "../icons";
import { FAVORITES_ID, useIsNarrow, usePrefetchOnVisible } from "./shared";
import { GLASS_PANEL, TERSE_INPUT } from "../../lib/ui";

/**
 * 行の見た目。地は1段沈んだ面（Sidebar 側）なので、ホバーと選択は
 * 白や灰の塗りではなく、地に対する濃さで付ける——どの面の上でも
 * 同じ量だけ濃くなり、ドロワー（本文の上に重なる）でも揃う。
 */
export const ROW_IDLE =
  "text-neutral-700 hover:bg-black/[0.04] dark:text-neutral-300 dark:hover:bg-white/[0.05]";
export const ROW_ACTIVE =
  "bg-black/[0.06] font-medium text-neutral-900 dark:bg-white/[0.08] dark:text-neutral-50";

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
      className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-neutral-400 hover:bg-black/[0.06] group-hover:block dark:hover:bg-white/10 [.menu-open&]:block touch:block touch:p-2.5"
    >
      <IconEllipsis className="h-4 w-4" />
    </button>
  );
}

/**
 * 「…」の中身。
 *
 * Mac ではボタンの下に出るポップオーバー、iPhone では画面の下端から
 * 上がるシート。中身は同じで、出し方だけ幅で変える。シートのときは
 * 行が指で押せる高さになり、何のメニューかが分かるよう名前を頭に置く。
 *
 * シートは body 直下へポータルで描く。ドロワーは transform で動かして
 * いるので、その中で fixed を使うと基準がドロワーになり、幅 288px の
 * 中に閉じ込められて下のドックに被る（実際にそうなっていた）。
 */
function MenuPanel({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const narrow = useIsNarrow();
  if (!narrow) {
    return (
      <div
        role="menu"
        className={`absolute right-1 top-8 z-40 w-44 origin-top-right rounded-xl p-1 animate-pop ${GLASS_PANEL}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    );
  }
  return createPortal(
    <div className="fixed inset-0 z-50" onClick={(e) => e.stopPropagation()}>
      {/* シートの背景。押したらメニューだけ閉じる（ドロワーは閉じない） */}
      <div className="absolute inset-0 bg-black/30 animate-fade" onClick={onClose} />
      <div
        role="menu"
        className={`absolute inset-x-2 bottom-[max(env(safe-area-inset-bottom),0.5rem)] rounded-2xl p-1.5 animate-sheet ${GLASS_PANEL}`}
      >
        <p className="truncate px-3 pb-1 pt-2 text-xs text-neutral-500 dark:text-neutral-400">
          {title}
        </p>
        {children}
      </div>
    </div>,
    document.body,
  );
}

const ITEM =
  "flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left text-[0.9375rem] text-neutral-700 hover:bg-black/[0.05] md:py-2 dark:text-neutral-200 dark:hover:bg-white/10";
const ITEM_DANGER =
  "flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left text-[0.9375rem] text-red-600 hover:bg-red-50 md:py-2 dark:text-red-400 dark:hover:bg-red-500/15";

export function MenuItems({ target }: { target: MenuTarget }) {
  const {
    conversations,
    folders,
    menu,
    setMenu,
    startRename,
    removeConversation,
    patchConversation,
    removeFolder,
    patchFolder,
    movePinned,
    openMoveDialog,
  } = useSidebar();
  if (!(menu?.type === target.type && menu.id === target.id)) return null;
  const close = () => setMenu(null);

  if (target.type === "conversation") {
    const c = conversations.find((x) => x.id === target.id);
    if (!c) return null;
    return (
      <MenuPanel title={c.title} onClose={close}>
        <button type="button" role="menuitem" className={ITEM} onClick={() => { close(); startRename(target); }}>
          名前を変更
        </button>
        <button type="button" role="menuitem" className={ITEM} onClick={() => { close(); void patchConversation(c.id, { favorite: c.favorite !== 1 }); }}>
          {c.favorite === 1 ? "お気に入りから外す" : "お気に入りに追加"}
        </button>
        <button type="button" role="menuitem" className={ITEM} onClick={() => { close(); void patchConversation(c.id, { pinned: !c.pinned }); }}>
          {c.pinned ? "ピン留めを解除" : "ピン留め"}
        </button>
        {c.pinned === 1 && (
          <>
            <button type="button" role="menuitem" className={ITEM} onClick={() => { close(); void movePinned("conversation", c.id, "up"); }}>
              <IconArrowUp className="h-4 w-4 text-neutral-400" />
              上へ移動
            </button>
            <button type="button" role="menuitem" className={ITEM} onClick={() => { close(); void movePinned("conversation", c.id, "down"); }}>
              <IconArrowDown className="h-4 w-4 text-neutral-400" />
              下へ移動
            </button>
          </>
        )}
        <button type="button" role="menuitem" className={ITEM} onClick={() => { close(); openMoveDialog(c.id); }}>
          フォルダへ移動…
        </button>
        <button type="button" role="menuitem" className={ITEM_DANGER} onClick={() => { close(); void removeConversation(c); }}>
          削除
        </button>
      </MenuPanel>
    );
  }

  const f = folders.find((x) => x.id === target.id);
  if (!f) return null;
  return (
    <MenuPanel title={f.name} onClose={close}>
      <button type="button" role="menuitem" className={ITEM} onClick={() => { close(); startRename(target); }}>
        名前を変更
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={() => { close(); void patchFolder(f.id, { pinned: !f.pinned }); }}>
        {f.pinned ? "ピン留めを解除" : "ピン留め"}
      </button>
      {f.pinned === 1 && (
        <>
          <button type="button" role="menuitem" className={ITEM} onClick={() => { close(); void movePinned("folder", f.id, "up"); }}>
            <IconArrowUp className="h-4 w-4 text-neutral-400" />
            上へ移動
          </button>
          <button type="button" role="menuitem" className={ITEM} onClick={() => { close(); void movePinned("folder", f.id, "down"); }}>
            <IconArrowDown className="h-4 w-4 text-neutral-400" />
            下へ移動
          </button>
        </>
      )}
      <button type="button" role="menuitem" className={ITEM_DANGER} onClick={() => { close(); void removeFolder(f); }}>
        削除
      </button>
    </MenuPanel>
  );
}

/**
 * 名前をその場で書き換える入力欄（会話・フォルダ・新しいフォルダ）。
 *
 * Enter で確定、Escape で取りやめ。欄の外を押したときは確定する
 * （Finder と同じ。打った名前を黙って捨てない）。空にして確定したら
 * 取りやめと同じ扱い。
 */
export function RenameField({
  initial,
  placeholder,
  label,
  onFinish,
}: {
  initial: string;
  placeholder?: string;
  label: string;
  onFinish: (name: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  /*
   * 確定と取りやめが二重に届かないように。Enter で確定したあと、
   * 欄が外れるときに blur も来る。先に決めたほうだけを通す。
   */
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onFinish(name);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(value.trim() || null);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={() => finish(value.trim() || null)}
      onClick={(e) => e.stopPropagation()}
      placeholder={placeholder}
      aria-label={label}
      {...TERSE_INPUT}
      className="w-full rounded-lg border border-accent/60 bg-white px-2.5 py-1.5 text-[0.9375rem] outline-none ring-2 ring-accent/20 dark:bg-neutral-950"
    />
  );
}

// --- 行レンダリング -----------------------------------------------------

export function ConversationItem({ c, indent = false }: { c: ConversationListRow; indent?: boolean }) {
  const { menu, isUnread, isGenerating, onNavigate, renaming, finishRename } =
    useSidebar();
  const open = menu?.type === "conversation" && menu.id === c.id;
  const generating = isGenerating(c);
  const prefetchRef = usePrefetchOnVisible(c.id);
  const editing = renaming?.type === "conversation" && renaming.id === c.id;
  return (
    <li ref={prefetchRef} className={`group relative ${open ? "menu-open" : ""} ${indent ? "ml-5" : ""}`}>
      {editing ? (
        <div className="px-1 py-0.5">
          <RenameField
            initial={c.title}
            label="新しい名前"
            onFinish={(name) => finishRename({ type: "conversation", id: c.id }, name)}
          />
        </div>
      ) : (
        <>
          {/* prefetch="intent": ホバー/タッチ開始でデータとJSを先読みし、遷移の待ちを隠す */}
          <NavLink
            to={`/chat/${c.id}`}
            prefetch="intent"
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-1.5 rounded-lg py-2 pl-3 pr-8 text-[0.9375rem] ${
                isActive ? ROW_ACTIVE : ROW_IDLE
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
                className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-300"
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
        </>
      )}
    </li>
  );
}

/** フォルダの行の中の件数。名前と同じ行に置く（別の flex 項目にすると上にずれて見える）。 */
function Count({ n }: { n: number }) {
  return (
    <span className="ml-1.5 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
      {n}
    </span>
  );
}

const DISCLOSURE =
  "shrink-0 rounded p-1 text-neutral-400 hover:bg-black/[0.06] touch:p-2.5 dark:hover:bg-white/10";

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
          className={DISCLOSURE}
        >
          <IconChevronRight
            className={`h-3.5 w-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
        </button>
        <button
          type="button"
          onClick={() => setView(FAVORITES_ID)}
          title="お気に入り（削除できない常設フォルダ）"
          className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-2 pl-1 pr-3 text-left text-[0.9375rem] ${ROW_IDLE}`}
        >
          <IconStarSolid className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-300" />
          <span className="min-w-0 flex-1 truncate">
            お気に入り
            <Count n={children.length} />
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
  const {
    menu,
    expanded,
    toggleExpanded,
    setView,
    conversationsIn,
    renaming,
    finishRename,
  } = useSidebar();
  const open = menu?.type === "folder" && menu.id === f.id;
  const isExpanded = expanded.has(f.id);
  const children = conversationsIn(f.id);
  const editing = renaming?.type === "folder" && renaming.id === f.id;
  return (
    <li className={`group relative ${open ? "menu-open" : ""}`}>
      {editing ? (
        <div className="px-1 py-0.5">
          <RenameField
            initial={f.name}
            label="フォルダの新しい名前"
            onFinish={(name) => finishRename({ type: "folder", id: f.id }, name)}
          />
        </div>
      ) : (
        <>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => toggleExpanded(f.id)}
              aria-label={isExpanded ? "折りたたむ" : "展開"}
              className={DISCLOSURE}
            >
              <IconChevronRight
                className={`h-3.5 w-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`}
              />
            </button>
            <button
              type="button"
              onClick={() => setView(f.id)}
              className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-2 pl-1 pr-8 text-left text-[0.9375rem] ${ROW_IDLE}`}
            >
              <IconFolder className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" />
              <span className="min-w-0 flex-1 truncate">
                {f.name}
                <Count n={children.length} />
              </span>
            </button>
          </div>
          <MenuButton target={{ type: "folder", id: f.id }} />
          <MenuItems target={{ type: "folder", id: f.id }} />
        </>
      )}
      {isExpanded && !editing && (
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
