import { useState } from "react";
import { Outlet } from "react-router";
import type { Route } from "./+types/shell";
import { listConversations } from "../lib/db.server";
import { fetchModels, type ModelInfo } from "../lib/openrouter.server";
import { Sidebar } from "../components/Sidebar";

export interface ShellContext {
  models: ModelInfo[];
  openSidebar: () => void;
}

export async function loader() {
  const [models, conversations] = await Promise.all([
    fetchModels(),
    listConversations(),
  ]);
  return { models, conversations };
}

export default function Shell({ loaderData }: Route.ComponentProps) {
  const { models, conversations } = loaderData;
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-dvh bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      {/* デスクトップ: 常設サイドバー */}
      <div className="hidden w-64 shrink-0 border-r border-gray-100 md:block dark:border-gray-800">
        <Sidebar conversations={conversations} />
      </div>

      {/* モバイル: ドロワー */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl dark:bg-gray-950">
            <Sidebar
              conversations={conversations}
              onNavigate={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <Outlet
          context={
            {
              models,
              openSidebar: () => setSidebarOpen(true),
            } satisfies ShellContext
          }
        />
      </div>
    </div>
  );
}
