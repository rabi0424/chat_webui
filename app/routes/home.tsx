import { useEffect, useMemo, useState } from "react";
import { useLocation, useOutletContext } from "react-router";
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

  /**
   * 「新規チャット」でこの画面へ来たら、選んでいたボットを外して
   * ランチャーに戻す。
   *
   * ホームに居るまま同じ行き先（"/"）へ遷移してもこの画面は
   * アンマウントされないので、状態を持ったままだと押しても何も
   * 起きないように見えていた。location.key は同じパスへの遷移でも
   * 毎回変わるので、これを合図に初期状態へ戻す。
   */
  const location = useLocation();
  useEffect(() => {
    setSelected(null);
    setSelectedModel(null);
  }, [location.key]);

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
        <p className="mt-3 text-lg font-medium text-neutral-800 dark:text-neutral-100">
          {selected.name}
        </p>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          メッセージを送って会話を開始
        </p>
        <button
          type="button"
          onClick={() => {
            setSelected(null);
            setSelectedModel(null);
          }}
          className="mt-3 rounded-lg px-3 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          選択を解除
        </button>
      </div>
    ) : undefined;

  return (
    <Chat
      /*
       * 「新規チャット」を押すたびに作り直す。
       *
       * 最初の送信では、生成の追従を切らないために navigate せず URL だけ
       * 差し替える（Chat 側を参照）。そのため React Router から見た現在地は
       * "/" のままで、ここで「新規チャット」を押しても "/" → "/" の遷移に
       * なり、ボットを選んでいなければ key が変わらず作り直されない。
       * すると画面は前の会話を映したままで、次の送信がその会話へ
       * 追記されてしまう。location.key は同じ行き先への遷移でも毎回
       * 変わるので、これを合図に作り直す。
       */
      key={`${selected?.id ?? "plain"}:${location.key}`}
      conversationId={null}
      initialMessages={[]}
      bot={selected}
      initialModel={selectedModel}
      emptyState={emptyState}
    />
  );
}
