import { useMemo, useState } from "react";
import { NavLink, useNavigate, useParams, useRevalidator } from "react-router";
import type { ConversationRow, FolderRow } from "../lib/db.server";
import { ThemeToggle } from "./ThemeToggle";

type MenuTarget =
  | { type: "conversation"; id: string }
  | { type: "folder"; id: string };

export function Sidebar({
  conversations,
  folders,
  onNavigate,
}: {
  conversations: ConversationRow[];
  folders: FolderRow[];
  onNavigate?: () => void;
}) {
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

  const viewFolder = view ? folders.find((f) => f.id === view) ?? null : null;

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

  // --- メニュー -----------------------------------------------------------

  function MenuButton({ target }: { target: MenuTarget }) {
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
        className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-gray-400 hover:bg-gray-200 group-hover:block dark:hover:bg-gray-700 [.menu-open&]:block"
      >
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 3a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM10 8.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM11.5 15.5a1.5 1.5 0 10-3 0 1.5 1.5 0 003 0z" />
        </svg>
      </button>
    );
  }

  function MenuItems({ target }: { target: MenuTarget }) {
    if (!(menu?.type === target.type && menu.id === target.id)) return null;
    const itemClass =
      "block w-full rounded-lg px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800";
    const close = () => setMenu(null);

    if (target.type === "conversation") {
      const c = conversations.find((x) => x.id === target.id);
      if (!c) return null;
      return (
        <div className="absolute right-1 top-8 z-40 w-44 rounded-xl border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <button type="button" className={itemClass} onClick={() => { close(); renameConversation(c); }}>
            名前を変更
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
          <button type="button" className={itemClass} onClick={() => { close(); setNewFolderName(""); setMoveTarget(c.id); }}>
            フォルダへ移動…
          </button>
          <button
            type="button"
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
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
      <div className="absolute right-1 top-8 z-40 w-44 rounded-xl border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
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
          className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
          onClick={() => { close(); void removeFolder(f); }}
        >
          削除
        </button>
      </div>
    );
  }

  // --- 行レンダリング -----------------------------------------------------

  function ConversationItem({ c, indent = false }: { c: ConversationRow; indent?: boolean }) {
    const open = menu?.type === "conversation" && menu.id === c.id;
    return (
      <li className={`group relative ${open ? "menu-open" : ""} ${indent ? "ml-5" : ""}`}>
        <NavLink
          to={`/chat/${c.id}`}
          onClick={onNavigate}
          className={({ isActive }) =>
            `block truncate rounded-lg py-2 pl-3 pr-8 text-sm ${
              isActive
                ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-50"
                : "text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900"
            }`
          }
        >
          {c.pinned === 1 && <span aria-hidden className="mr-1">📌</span>}
          {c.title}
        </NavLink>
        <MenuButton target={{ type: "conversation", id: c.id }} />
        <MenuItems target={{ type: "conversation", id: c.id }} />
      </li>
    );
  }

  function FolderItem({ f }: { f: FolderRow }) {
    const open = menu?.type === "folder" && menu.id === f.id;
    const isExpanded = expanded.has(f.id);
    const children = folderConversations(f.id);
    return (
      <li className={`group relative ${open ? "menu-open" : ""}`}>
        <div className="flex items-center">
          <button
            type="button"
            onClick={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(f.id)) next.delete(f.id);
                else next.add(f.id);
                return next;
              })
            }
            aria-label={isExpanded ? "折りたたむ" : "展開"}
            className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <svg
              className={`h-3.5 w-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`}
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setView(f.id)}
            className="min-w-0 flex-1 truncate rounded-lg py-2 pl-1 pr-8 text-left text-sm text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900"
          >
            {f.pinned === 1 && <span aria-hidden className="mr-1">📌</span>}
            <span aria-hidden className="mr-1.5">📁</span>
            {f.name}
            <span className="ml-1.5 text-xs text-gray-400 dark:text-gray-600">
              {children.length}
            </span>
          </button>
        </div>
        <MenuButton target={{ type: "folder", id: f.id }} />
        <MenuItems target={{ type: "folder", id: f.id }} />
        {isExpanded && (
          <ul className="mt-0.5 space-y-0.5">
            {children.length === 0 && (
              <li className="ml-5 px-3 py-1.5 text-xs text-gray-400 dark:text-gray-600">
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

  const moveConv = moveTarget
    ? conversations.find((c) => c.id === moveTarget)
    : null;

  return (
    <div className="flex h-full flex-col" onClick={() => menu && setMenu(null)}>
      <div className="space-y-1.5 p-3">
        <NavLink
          to="/"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
          </svg>
          新規チャット
        </NavLink>
        <NavLink
          to="/bots"
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${
              isActive
                ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-50"
                : "text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900"
            }`
          }
        >
          <span aria-hidden>🤖</span>
          ボット管理
        </NavLink>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {viewFolder ? (
          /* --- フォルダ階層表示 --- */
          <>
            <div className="mb-1 flex items-center gap-1 px-1">
              <button
                type="button"
                onClick={() => setView(null)}
                aria-label="戻る"
                className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08l-4.158 3.96H16.25A.75.75 0 0117 10z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
              <span className="truncate text-sm font-medium">
                📁 {viewFolder.name}
              </span>
            </div>
            <ul className="space-y-0.5">
              {folderConversations(viewFolder.id).length === 0 && (
                <li className="px-3 py-6 text-center text-xs text-gray-400 dark:text-gray-600">
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
                <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-gray-400 dark:text-gray-600">
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
              <p className="text-[11px] font-medium text-gray-400 dark:text-gray-600">
                フォルダ
              </p>
              <button
                type="button"
                onClick={() => void createFolderPrompt()}
                aria-label="フォルダを作成"
                title="フォルダを作成"
                className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                </svg>
              </button>
            </div>
            <ul className="space-y-0.5">
              {unpinnedFolders.map((f) => (
                <FolderItem key={f.id} f={f} />
              ))}
            </ul>

            <p className="px-3 pb-1 pt-3 text-[11px] font-medium text-gray-400 dark:text-gray-600">
              会話
            </p>
            {rootConversations.length === 0 && pinnedItems.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-gray-400 dark:text-gray-600">
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

      <div className="border-t border-gray-100 p-3 dark:border-gray-800">
        <ThemeToggle />
      </div>

      {/* フォルダ移動モーダル */}
      {moveConv && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setMoveTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-3 text-sm font-semibold">
              「{moveConv.title}」をフォルダへ移動
            </p>
            <div className="max-h-60 space-y-1 overflow-y-auto">
              {moveConv.folder_id != null && (
                <button
                  type="button"
                  onClick={() => {
                    void patchConversation(moveConv.id, { folderId: null });
                    setMoveTarget(null);
                  }}
                  className="block w-full rounded-lg px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
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
                  className="block w-full rounded-lg px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  📁 {f.name}
                </button>
              ))}
              {folders.length === 0 && (
                <p className="px-3 py-2 text-xs text-gray-400">
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
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-800"
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
                className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-30"
              >
                作成して移動
              </button>
            </div>
            <div className="mt-2 text-right">
              <button
                type="button"
                onClick={() => setMoveTarget(null)}
                className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
