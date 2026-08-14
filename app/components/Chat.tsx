import { useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext, useRevalidator } from "react-router";
import type { ShellContext } from "../routes/shell";
import type { UiMessage } from "../lib/types";
import { paramsForRequest } from "../lib/params";
import { parseSSE } from "../lib/sse";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";

/** この会話に適用されるボット設定（会話開始時のスナップショット）。 */
export interface BotContext {
  id: string | null;
  name: string;
  icon: string;
  systemPrompt: string | null;
  params: Record<string, number> | null;
}

const MODEL_STORAGE_KEY = "chat-webui:model";
const WEB_STORAGE_KEY = "chat-webui:web-search";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

/** 分岐点に表示する ‹ 2/3 › 型の控えめなページャ。 */
function BranchPager({
  message,
  disabled,
  onSwitch,
}: {
  message: UiMessage;
  disabled: boolean;
  onSwitch: (targetId: string) => void;
}) {
  const { siblingIds, siblingIndex } = message;
  if (!siblingIds || siblingIds.length < 2 || siblingIndex == null) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-gray-400 dark:text-gray-500">
      <button
        type="button"
        disabled={disabled || siblingIndex === 0}
        onClick={() => onSwitch(siblingIds[siblingIndex - 1])}
        className="rounded px-1 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        aria-label="前のブランチ"
      >
        ‹
      </button>
      <span className="tabular-nums">
        {siblingIndex + 1}/{siblingIds.length}
      </span>
      <button
        type="button"
        disabled={disabled || siblingIndex === siblingIds.length - 1}
        onClick={() => onSwitch(siblingIds[siblingIndex + 1])}
        className="rounded px-1 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        aria-label="次のブランチ"
      >
        ›
      </button>
    </span>
  );
}

export function Chat({
  conversationId,
  initialMessages,
  bot = null,
  initialModel = null,
  emptyState,
}: {
  conversationId: string | null;
  initialMessages: UiMessage[];
  bot?: BotContext | null;
  initialModel?: string | null;
  emptyState?: React.ReactNode;
}) {
  const { models, openSidebar } = useOutletContext<ShellContext>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [model, setModel] = useState(initialModel ?? DEFAULT_MODEL);
  const [webSearch, setWebSearch] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(
    null,
  );

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 保存処理の直列化用（連投時に順序が崩れないように）
  const persistChain = useRef<Promise<void>>(Promise.resolve());
  // 古い非同期処理が新しいストリームの表示を上書きしないための世代カウンタ
  const epochRef = useRef(0);

  useEffect(() => {
    // 会話やボットが持つモデルを優先。なければ前回使ったモデルを復元
    if (!initialModel) {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY);
      if (saved && models.some((m) => m.id === saved)) {
        setModel(saved);
      } else if (!models.some((m) => m.id === DEFAULT_MODEL) && models[0]) {
        setModel(models[0].id);
      }
    }
    setWebSearch(localStorage.getItem(WEB_STORAGE_KEY) === "1");
  }, [models, initialModel]);

  const selectModel = (id: string) => {
    setModel(id);
    localStorage.setItem(MODEL_STORAGE_KEY, id);
    // 会話ごとの選択モデルを記憶（リロード・別端末でも維持）
    if (conversationId) {
      void fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: id }),
      }).catch(() => {});
    }
  };

  const toggleWebSearch = () => {
    setWebSearch((v) => {
      localStorage.setItem(WEB_STORAGE_KEY, v ? "0" : "1");
      return !v;
    });
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  /** 現在のパスをサーバーから取り直す（ページャ情報の更新用）。 */
  async function refreshPath(convId: string, epoch: number) {
    try {
      const res = await fetch(`/api/conversations/${convId}/path`);
      if (!res.ok) return;
      const { messages: fresh } = (await res.json()) as {
        messages: UiMessage[];
      };
      if (epochRef.current === epoch) setMessages(fresh);
    } catch {
      // 表示更新に失敗しても実害はない
    }
  }

  /**
   * 表示中リストの末尾にある未保存メッセージをDBへ保存する。
   * 直前の保存済みメッセージが親になる（編集・再生成時は自動的に分岐になる）。
   */
  async function persist(finalMessages: UiMessage[], epoch: number) {
    const firstUnsaved = finalMessages.findIndex((m) => !m.id);
    if (firstUnsaved === -1) return;
    const tail = finalMessages
      .slice(firstUnsaved)
      .filter((m) => m.content !== "");
    if (tail.length === 0) return;
    const parentId = finalMessages[firstUnsaved - 1]?.id ?? null;

    try {
      let convId = conversationId;
      const isNew = !convId;
      if (!convId) {
        const firstUser = tail.find((m) => m.role === "user");
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelId: model,
            botId: bot?.id ?? undefined,
            title: (firstUser?.content ?? "新しいチャット").slice(0, 40),
          }),
        });
        if (!res.ok) throw new Error();
        convId = ((await res.json()) as { id: string }).id;
      }

      const res = await fetch(`/api/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentId,
          messages: tail.map((m) => ({
            role: m.role,
            content: m.content,
            modelId: m.role === "assistant" ? model : undefined,
            usageJson: m.usage ? JSON.stringify(m.usage) : undefined,
          })),
        }),
      });
      if (!res.ok) throw new Error();
      const { ids } = (await res.json()) as { ids: string[] };

      // 採番されたIDをローカル状態に反映
      setMessages((prev) => {
        const next = [...prev];
        let k = 0;
        for (let i = 0; i < next.length && k < tail.length; i++) {
          if (!next[i].id && next[i].content === tail[k].content) {
            next[i] = { ...next[i], id: ids[k] };
            k++;
          }
        }
        return next;
      });

      if (isNew) {
        const user = tail.find((m) => m.role === "user");
        const assistant = tail.find((m) => m.role === "assistant");
        if (user && assistant) {
          await fetch(`/api/conversations/${convId}/title`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userText: user.content,
              assistantText: assistant.content,
            }),
          }).catch(() => {});
        }
        navigate(`/chat/${convId}`, { replace: true });
      } else {
        // 分岐点のページャ表示を最新化しつつ、サイドバーの並びも更新
        await refreshPath(convId, epoch);
        revalidator.revalidate();
      }
    } catch {
      setError(
        "会話の保存に失敗しました。次のメッセージ送信時に再保存を試みます。",
      );
    }
  }

  async function runCompletion(history: UiMessage[]) {
    setError(null);
    setIsStreaming(true);
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setMessages([...history, { role: "assistant", content: "" }]);

    let finalMessages: UiMessage[] = history;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          web: webSearch,
          params: paramsForRequest(bot?.params),
          messages: [
            ...(bot?.systemPrompt
              ? [{ role: "system", content: bot.systemPrompt }]
              : []),
            ...history.map(({ role, content }) => ({ role, content })),
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `エラーが発生しました (${res.status})`);
      }
      if (!res.body) throw new Error("応答が空でした");

      let content = "";
      let usage: UiMessage["usage"];
      let finishReason: string | undefined;
      for await (const data of parseSSE(res.body)) {
        let chunk: {
          choices?: {
            delta?: { content?: string };
            finish_reason?: string | null;
          }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            cost?: number;
          };
          error?: { message?: string };
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error?.message) throw new Error(chunk.error.message);

        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (delta) content += delta;
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            cost: chunk.usage.cost,
          };
        }
        finalMessages = [...history, { role: "assistant", content, usage }];
        if (epochRef.current === epoch) setMessages(finalMessages);
      }

      // ストリームは正常終了したが本文が空（ツール呼び出しの試行や
      // セーフティ判定などで起きる）。空の吹き出しを残さず理由を表示する。
      if (content === "") {
        finalMessages = history;
        if (epochRef.current === epoch) setMessages(finalMessages);
        setError(
          `モデルから本文のない応答が返りました${
            finishReason ? `（finish_reason: ${finishReason}）` : ""
          }。モデルを変えるか、もう一度お試しください。`,
        );
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message);
        // 中身のないアシスタントメッセージは表示から取り除く
        finalMessages = finalMessages.filter(
          (m, i) =>
            !(
              i === finalMessages.length - 1 &&
              m.role === "assistant" &&
              m.content === ""
            ),
        );
        if (epochRef.current === epoch) setMessages(finalMessages);
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      const toPersist = finalMessages;
      persistChain.current = persistChain.current.then(() =>
        persist(toPersist, epoch),
      );
    }
  }

  function send() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    void runCompletion([...messages, { role: "user", content: text }]);
  }

  function stop() {
    abortRef.current?.abort();
  }

  function regenerate() {
    if (isStreaming) return;
    const history = [...messages];
    while (history.length > 0 && history[history.length - 1].role === "assistant") {
      history.pop();
    }
    if (history.length === 0) return;
    void runCompletion(history);
  }

  /** 過去メッセージの編集・再送信（同一会話内で分岐を作る）。 */
  function submitEdit() {
    if (!editing || isStreaming) return;
    const text = editing.text.trim();
    if (!text) return;
    const history = [
      ...messages.slice(0, editing.index),
      { role: "user" as const, content: text },
    ];
    setEditing(null);
    void runCompletion(history);
  }

  /** ブランチ切替（ページャ）。 */
  async function switchBranch(targetId: string) {
    if (isStreaming || !conversationId) return;
    try {
      const res = await fetch(`/api/conversations/${conversationId}/path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: targetId }),
      });
      if (!res.ok) throw new Error();
      const { messages: fresh } = (await res.json()) as {
        messages: UiMessage[];
      };
      setMessages(fresh);
      setError(null);
    } catch {
      setError("ブランチの切替に失敗しました。");
    }
  }

  /** ここから分岐: この地点までの履歴で独立した新会話を作る。 */
  async function fork(messageId: string) {
    if (isStreaming || !conversationId) return;
    if (
      !confirm(
        "ここまでの履歴をコピーして、独立した新しい会話を作成します。よろしいですか？",
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/conversations/${conversationId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
      });
      if (!res.ok) throw new Error();
      const { id } = (await res.json()) as { id: string };
      await navigate(`/chat/${id}`);
    } catch {
      setError("分岐の作成に失敗しました。");
    }
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
        {bot && (
          <span
            className="flex min-w-0 shrink items-center gap-1.5 rounded-lg bg-gray-100 px-2.5 py-1.5 text-sm font-medium dark:bg-gray-800"
            title={bot.systemPrompt ?? undefined}
          >
            <span aria-hidden>{bot.icon}</span>
            <span className="truncate">{bot.name}</span>
          </span>
        )}
        <ModelPicker models={models} value={model} onChange={selectModel} />
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          {messages.length === 0 && (
            <div className="flex min-h-[60vh] items-center justify-center text-gray-300 dark:text-gray-600">
              {emptyState ?? (
                <p className="text-lg">モデルを選んでメッセージを送信</p>
              )}
            </div>
          )}
          <div className="space-y-6">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={m.id ?? `u${i}`} className="group/msg">
                  {editing?.index === i ? (
                    <div className="rounded-2xl border border-indigo-300 bg-gray-50 p-3 dark:border-indigo-700 dark:bg-gray-900">
                      <textarea
                        value={editing.text}
                        onChange={(e) =>
                          setEditing({ index: i, text: e.target.value })
                        }
                        rows={3}
                        autoFocus
                        className="w-full resize-y bg-transparent outline-none"
                      />
                      <div className="mt-2 flex justify-end gap-2 text-sm">
                        <button
                          type="button"
                          onClick={() => setEditing(null)}
                          className="rounded-lg px-3 py-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                        >
                          キャンセル
                        </button>
                        <button
                          type="button"
                          onClick={submitEdit}
                          disabled={!editing.text.trim()}
                          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-500 disabled:opacity-30"
                        >
                          送信
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex justify-end">
                        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2.5 text-white">
                          {m.content}
                        </div>
                      </div>
                      <div className="mt-1 flex items-center justify-end gap-2">
                        <BranchPager
                          message={m}
                          disabled={isStreaming}
                          onSwitch={switchBranch}
                        />
                        {m.id && !isStreaming && (
                          <button
                            type="button"
                            onClick={() => setEditing({ index: i, text: m.content })}
                            aria-label="編集して再送信"
                            title="編集して再送信（分岐を作成）"
                            className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-600 group-hover/msg:text-gray-400 dark:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300 dark:group-hover/msg:text-gray-500"
                          >
                            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div key={m.id ?? `a${i}`} className="group/msg">
                  <Markdown>{m.content}</Markdown>
                  {isStreaming && i === messages.length - 1 && (
                    <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-gray-400 align-text-bottom dark:bg-gray-500" />
                  )}
                  <div className="mt-1 flex items-center gap-3">
                    <BranchPager
                      message={m}
                      disabled={isStreaming}
                      onSwitch={switchBranch}
                    />
                    {m.usage && (
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {m.usage.promptTokens} in / {m.usage.completionTokens} out
                        {m.usage.cost != null && ` · $${m.usage.cost.toFixed(6)}`}
                      </span>
                    )}
                    {m.id && !isStreaming && (
                      <button
                        type="button"
                        onClick={() => void fork(m.id!)}
                        title="ここから分岐（独立した新しい会話を作成）"
                        className="rounded px-1.5 py-0.5 text-xs text-gray-300 hover:bg-gray-100 hover:text-gray-600 group-hover/msg:text-gray-400 dark:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300 dark:group-hover/msg:text-gray-500"
                      >
                        ⑂ ここから分岐
                      </button>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>

          {error && (
            <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              <span className="break-all">{error}</span>
              <button
                type="button"
                onClick={regenerate}
                className="shrink-0 rounded-lg border border-red-300 px-3 py-1 hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900"
              >
                再試行
              </button>
            </div>
          )}

          {!isStreaming &&
            !error &&
            messages[messages.length - 1]?.role === "assistant" && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={regenerate}
                  className="rounded-lg px-2 py-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                >
                  ↻ 再生成
                </button>
              </div>
            )}
        </div>
      </div>

      <footer className="shrink-0 border-t border-gray-100 px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3 dark:border-gray-800">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <button
            type="button"
            onClick={toggleWebSearch}
            aria-pressed={webSearch}
            title={
              webSearch
                ? "Web検索: オン（検索1回ごとに数円の追加料金がかかります）"
                : "Web検索: オフ"
            }
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-full border transition-colors ${
              webSearch
                ? "border-indigo-400 bg-indigo-50 text-indigo-600 dark:border-indigo-600 dark:bg-indigo-950 dark:text-indigo-300"
                : "border-gray-200 text-gray-400 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-500 dark:hover:bg-gray-900"
            }`}
            aria-label="Web検索の切替"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.262 6.072a8.25 8.25 0 1010.562-.766 4.5 4.5 0 01-1.318 1.357L14.25 7.5l.165.33a.809.809 0 01-1.086 1.085l-.604-.302a1.125 1.125 0 00-1.298.21l-.132.131c-.439.44-.439 1.152 0 1.591l.296.296c.256.257.622.374.98.314l1.17-.195c.323-.054.654.036.905.245l1.33 1.108c.32.267.46.694.358 1.1a8.7 8.7 0 01-2.288 4.04l-.723.724a1.125 1.125 0 01-1.298.21l-.153-.076a1.125 1.125 0 01-.622-1.006v-1.089c0-.298-.119-.585-.33-.796l-1.347-1.347a1.125 1.125 0 01-.21-1.298L9.75 12l-1.64-1.64a6 6 0 01-1.676-3.257l-.172-1.03z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 200)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder="メッセージを入力…（Shift+Enterで改行）"
            className="max-h-[200px] min-h-[44px] flex-1 resize-none rounded-2xl border border-gray-200 bg-gray-50 px-4 py-2.5 outline-none placeholder:text-gray-400 focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-900 dark:focus:border-indigo-500"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={stop}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
              aria-label="停止"
            >
              <span className="block h-3.5 w-3.5 rounded-sm bg-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!input.trim()}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30"
              aria-label="送信"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
              </svg>
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
