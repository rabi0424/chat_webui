import { useState } from "react";
import { Outlet } from "react-router";
import type { Route } from "./+types/shell";
import { listBots, listConversations, listFolders, type BotRow, type FolderRow } from "../lib/db.server";
import { fetchModels, type ModelInfo } from "../lib/openrouter.server";
import { Sidebar } from "../components/Sidebar";

export interface ShellContext {
  models: ModelInfo[];
  bots: BotRow[];
  openSidebar: () => void;
}

export async function loader() {
  const [models, conversations, bots, folders] = await Promise.all([
    fetchModels(),
    listConversations(),
    listBots(),
    listFolders(),
  ]);
  return { models, conversations, bots, folders };
}

export default function Shell({ loaderData }: Route.ComponentProps) {
  const { models, conversations, bots, folders } = loaderData;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarClosing, setSidebarClosing] = useState(false);

  /** 閉じるときも開くときと同じ滑らかさで（退場アニメーション後にアンマウント）。 */
  const closeSidebar = () => {
    if (sidebarClosing) return;
    setSidebarClosing(true);
    setTimeout(() => {
      setSidebarOpen(false);
      setSidebarClosing(false);
    }, 220);
  };

  return (
    <div className="flex h-dvh overflow-x-hidden bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {/* デスクトップ: 常設サイドバー */}
      <div className="hidden w-64 shrink-0 border-r border-neutral-100 md:block dark:border-neutral-800">
        <Sidebar conversations={conversations} folders={folders} />
      </div>

      {/* モバイル: ドロワー */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 md:hidden">
          <div
            className={`absolute inset-0 bg-black/40 backdrop-blur-sm ${
              sidebarClosing ? "animate-fade-out" : "animate-fade"
            }`}
            onClick={closeSidebar}
          />
          <div
            className={`absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl dark:bg-neutral-950 ${
              sidebarClosing ? "animate-drawer-out" : "animate-drawer"
            }`}
          >
            <Sidebar
              conversations={conversations}
              folders={folders}
              onNavigate={closeSidebar}
            />
          </div>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <Outlet
          context={
            {
              models,
              bots,
              openSidebar: () => setSidebarOpen(true),
            } satisfies ShellContext
          }
        />
      </div>
    </div>
  );
}
