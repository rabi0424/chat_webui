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
        <p className="mb-3 text-center text-sm text-neutral-400 dark:text-neutral-500">
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
              className="rounded-2xl border border-neutral-200 px-3 py-4 text-center transition hover:border-accent/50 hover:bg-accent/5 active:scale-[0.97] dark:border-neutral-700"
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
            className="text-xs text-neutral-400 underline-offset-2 hover:underline dark:text-neutral-500"
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
        <p className="mt-3 text-lg font-medium text-neutral-600 dark:text-neutral-300">
          {selected.name}
        </p>
        <p className="mt-1 text-sm text-neutral-400 dark:text-neutral-500">
          メッセージを送って会話を開始
        </p>
        <button
          type="button"
          onClick={() => {
            setSelected(null);
            setSelectedModel(null);
          }}
          className="mt-3 rounded-lg px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
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
