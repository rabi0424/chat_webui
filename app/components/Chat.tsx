import { useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext, useRevalidator } from "react-router";
import type { ShellContext } from "../routes/shell";
import { parseSSE } from "../lib/sse";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";

export interface UiMessage {
  /** DB上のID。未保存メッセージでは undefined。 */
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  usage?: { promptTokens: number; completionTokens: number; cost?: number };
}

const MODEL_STORAGE_KEY = "chat-webui:model";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

export function Chat({
  conversationId,
  initialMessages,
}: {
  conversationId: string | null;
  initialMessages: UiMessage[];
}) {
  const { models, openSidebar } = useOutletContext<ShellContext>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [model, setModel] = useState(DEFAULT_MODEL);
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 保存処理の直列化用（連投時に順序が崩れないように）
  const persistChain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const saved = localStorage.getItem(MODEL_STORAGE_KEY);
    if (saved && models.some((m) => m.id === saved)) {
      setModel(saved);
    } else if (!models.some((m) => m.id === DEFAULT_MODEL) && models[0]) {
      setModel(models[0].id);
    }
  }, [models]);

  const selectModel = (id: string) => {
    setModel(id);
    localStorage.setItem(MODEL_STORAGE_KEY, id);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  /**
   * 表示中リストの末尾にある未保存メッセージをDBへ保存する。
   * 直前の保存済みメッセージが親になる（再生成時は自動的に分岐になる）。
   */
  async function persist(finalMessages: UiMessage[]) {
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
          messages: history.map(({ role, content }) => ({ role, content })),
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
      for await (const data of parseSSE(res.body)) {
        let chunk: {
          choices?: { delta?: { content?: string } }[];
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

        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) content += delta;
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            cost: chunk.usage.cost,
          };
        }
        finalMessages = [
          ...history,
          { role: "assistant", content, usage },
        ];
        setMessages(finalMessages);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message);
        // 中身のないアシスタントメッセージは表示から取り除く
        finalMessages = finalMessages.filter(
          (m, i) =>
            !(i === finalMessages.length - 1 && m.role === "assistant" && m.content === ""),
        );
        setMessages(finalMessages);
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      const toPersist = finalMessages;
      persistChain.current = persistChain.current.then(() =>
        persist(toPersist),
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
        <ModelPicker models={models} value={model} onChange={selectModel} />
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          {messages.length === 0 && (
            <div className="flex h-[60vh] items-center justify-center text-gray-300 dark:text-gray-600">
              <p className="text-lg">モデルを選んでメッセージを送信</p>
            </div>
          )}
          <div className="space-y-6">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={m.id ?? `u${i}`} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2.5 text-white">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id ?? `a${i}`}>
                  <Markdown>{m.content}</Markdown>
                  {isStreaming && i === messages.length - 1 && (
                    <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-gray-400 align-text-bottom dark:bg-gray-500" />
                  )}
                  {m.usage && (
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                      {m.usage.promptTokens} in / {m.usage.completionTokens} out
                      {m.usage.cost != null && ` · $${m.usage.cost.toFixed(6)}`}
                    </p>
                  )}
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
