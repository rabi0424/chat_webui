import { Link, useNavigate, useOutletContext, useRevalidator } from "react-router";
import type { Route } from "./+types/bots";
import type { ShellContext } from "./shell";

export function meta({}: Route.MetaArgs) {
  return [{ title: "ボット管理 - Chat WebUI" }];
}

export default function Bots() {
  const { bots, models, openSidebar } = useOutletContext<ShellContext>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();

  async function remove(id: string, name: string) {
    if (!confirm(`ボット「${name}」を削除しますか？既存の会話には影響しません。`)) {
      return;
    }
    await fetch(`/api/bots/${id}`, { method: "DELETE" });
    revalidator.revalidate();
  }

  async function duplicate(id: string) {
    const bot = bots.find((b) => b.id === id);
    if (!bot) return;
    await fetch("/api/bots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${bot.name}のコピー`.slice(0, 60),
        icon: bot.icon,
        modelId: bot.model_id,
        systemPrompt: bot.system_prompt,
        params: bot.params_json ? JSON.parse(bot.params_json) : null,
      }),
    });
    revalidator.revalidate();
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-gray-100 px-3 py-2 dark:border-gray-800">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="メニュー"
          className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 md:hidden dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 10.5a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <h1 className="px-1 text-sm font-semibold tracking-tight">ボット管理</h1>
        <div className="ml-auto">
          <Link
            to="/bots/new"
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            + 新しいボット
          </Link>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-6">
          {bots.length === 0 && (
            <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center dark:border-gray-700">
              <p className="text-gray-400 dark:text-gray-500">
                ボットはまだありません。
                <br />
                「モデル + システムプロンプト」の組み合わせを登録すると、
                新規チャット画面から1タップで会話を始められます。
              </p>
            </div>
          )}
          <ul className="space-y-2">
            {bots.map((b) => (
              <li
                key={b.id}
                className="flex items-center gap-3 rounded-2xl border border-gray-200 px-4 py-3 dark:border-gray-700"
              >
                <span className="text-2xl" aria-hidden>
                  {b.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{b.name}</p>
                  <p className="truncate text-xs text-gray-400 dark:text-gray-500">
                    {models.find((m) => m.id === b.model_id)?.name ?? b.model_id}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1 text-sm">
                  <button
                    type="button"
                    onClick={() => void navigate(`/bots/${b.id}/edit`)}
                    className="rounded-lg px-2.5 py-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                  >
                    編集
                  </button>
                  <button
                    type="button"
                    onClick={() => void duplicate(b.id)}
                    className="rounded-lg px-2.5 py-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                  >
                    複製
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(b.id, b.name)}
                    className="rounded-lg px-2.5 py-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                  >
                    削除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
