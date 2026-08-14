import { useState } from "react";
import { Link, useOutletContext } from "react-router";
import type { Route } from "./+types/home";
import type { ShellContext } from "./shell";
import { parseParamsJson } from "../lib/params";
import { Chat, type BotContext } from "../components/Chat";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Chat WebUI" }];
}

export default function Home() {
  const { bots } = useOutletContext<ShellContext>();
  const [selected, setSelected] = useState<BotContext | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const emptyState =
    bots.length > 0 && !selected ? (
      <div className="w-full">
        <p className="mb-3 text-center text-sm text-gray-400 dark:text-gray-500">
          ボットを選ぶか、そのままメッセージを送信
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {bots.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                setSelected({
                  id: b.id,
                  name: b.name,
                  icon: b.icon,
                  systemPrompt: b.system_prompt,
                  params: parseParamsJson(b.params_json),
                });
                setSelectedModel(b.model_id);
              }}
              className="rounded-2xl border border-gray-200 px-3 py-4 text-center hover:border-indigo-300 hover:bg-indigo-50/50 dark:border-gray-700 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30"
            >
              <span className="block text-3xl" aria-hidden>
                {b.icon}
              </span>
              <span className="mt-1.5 block truncate text-sm font-medium">
                {b.name}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-4 text-center">
          <Link
            to="/bots"
            className="text-xs text-gray-400 underline-offset-2 hover:underline dark:text-gray-500"
          >
            ボットを管理
          </Link>
        </p>
      </div>
    ) : selected ? (
      <div className="text-center">
        <span className="block text-5xl" aria-hidden>
          {selected.icon}
        </span>
        <p className="mt-3 text-lg font-medium text-gray-600 dark:text-gray-300">
          {selected.name}
        </p>
        <p className="mt-1 text-sm text-gray-400 dark:text-gray-500">
          メッセージを送って会話を開始
        </p>
        <button
          type="button"
          onClick={() => {
            setSelected(null);
            setSelectedModel(null);
          }}
          className="mt-3 rounded-lg px-3 py-1 text-xs text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          選択を解除
        </button>
      </div>
    ) : undefined;

  return (
    <Chat
      key={selected?.id ?? "plain"}
      conversationId={null}
      initialMessages={[]}
      bot={selected}
      initialModel={selectedModel}
      emptyState={emptyState}
    />
  );
}
