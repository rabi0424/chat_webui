import { useMemo, useState } from "react";
import { useOutletContext } from "react-router";
import type { Route } from "./+types/home";
import type { ShellContext } from "./shell";
import { parseParamsJson } from "../lib/params";
import { Chat, type BotContext } from "../components/Chat";
import { HomeEmptyState } from "../components/HomeEmptyState";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Chat WebUI" }];
}

export default function Home() {
  const { bots, models } = useOutletContext<ShellContext>();
  const [selected, setSelected] = useState<BotContext | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const modelNames = useMemo(
    () => new Map(models.map((m) => [m.id, m.name])),
    [models],
  );

  const emptyState =
    bots.length > 0 && !selected ? (
      <HomeEmptyState
        bots={bots}
        modelNames={modelNames}
        onSelect={(b) => {
          const bot = bots.find((x) => x.id === b.id)!;
          setSelected({
            id: bot.id,
            name: bot.name,
            icon: bot.icon,
            systemPrompt: bot.system_prompt,
            params: parseParamsJson(bot.params_json),
          });
          setSelectedModel(bot.model_id);
        }}
      />
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
