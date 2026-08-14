import { NavLink, useNavigate, useParams, useRevalidator } from "react-router";
import type { ConversationRow } from "../lib/db.server";

export function Sidebar({
  conversations,
  onNavigate,
}: {
  conversations: ConversationRow[];
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const params = useParams();

  async function remove(id: string, title: string) {
    if (!confirm(`「${title}」を削除しますか？この操作は取り消せません。`)) {
      return;
    }
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (params.id === id) {
      navigate("/");
    }
    revalidator.revalidate();
  }

  return (
    <div className="flex h-full flex-col">
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
        {conversations.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-gray-400 dark:text-gray-600">
            まだ会話はありません
          </p>
        )}
        <ul className="space-y-0.5">
          {conversations.map((c) => (
            <li key={c.id} className="group relative">
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
                {c.title}
              </NavLink>
              <button
                type="button"
                onClick={() => void remove(c.id, c.title)}
                aria-label="削除"
                className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-red-600 group-hover:block dark:hover:bg-gray-700"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
