import { useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext, useRevalidator } from "react-router";
import type { ShellContext } from "../routes/shell";
import type { UiMessage } from "../lib/types";
import { type ParamsState } from "../lib/params";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import { ParamsEditor } from "./ParamsEditor";

/** この会話に適用されるボット設定（会話開始時のスナップショット）。 */
export interface BotContext {
  id: string | null;
  name: string;
  icon: string;
  systemPrompt: string | null;
  params: ParamsState | null;
}

const MODEL_STORAGE_KEY = "chat-webui:model";
const WEB_STORAGE_KEY = "chat-webui:web-search";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const POLL_INTERVAL_MS = 500;

/** thinking対応モデルの思考内容の折りたたみ表示。 */
function ReasoningBlock({
  reasoning,
  streaming,
}: {
  reasoning: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const show = open || streaming;
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
      >
        <span aria-hidden>💭</span>
        {streaming ? "思考中…" : show ? "思考プロセスを隠す" : "思考プロセスを表示"}
      </button>
      {show && (
        <div className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
          {reasoning}
        </div>
      )}
    </div>
  );
}

/** ワンタップコピー（1.5秒だけ✓を表示）。 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="コピー"
      title="コピー"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // クリップボード不許可時は何もしない
        }
      }}
      className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-600 group-hover/msg:text-gray-400 dark:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300 dark:group-hover/msg:text-gray-500"
    >
      {copied ? (
        <svg className="h-3.5 w-3.5 text-green-500" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
            clipRule="evenodd"
          />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
          <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
        </svg>
      )}
    </button>
  );
}

/** 応答の詳細情報（トークン・金額・時刻・所要時間・速度）のポップオーバー。 */
function MessageDetails({ message }: { message: UiMessage }) {
  const [open, setOpen] = useState(false);
  const u = message.usage;
  const durationMs =
    message.finishedAt && message.createdAt
      ? message.finishedAt - message.createdAt
      : null;
  const tokensPerSec =
    durationMs && durationMs > 0 && u
      ? (u.completionTokens / (durationMs / 1000)).toFixed(1)
      : null;

  const rows: [string, string][] = [];
  if (message.modelId) rows.push(["モデル", message.modelId]);
  if (u) {
    rows.push(["入力トークン", u.promptTokens.toLocaleString()]);
    if (u.cachedTokens != null && u.cachedTokens > 0) {
      rows.push([
        "うちキャッシュ読取",
        `${u.cachedTokens.toLocaleString()}（割引適用）`,
      ]);
    }
    rows.push(["出力トークン", u.completionTokens.toLocaleString()]);
    if (u.reasoningTokens != null && u.reasoningTokens > 0) {
      rows.push(["うち思考トークン", u.reasoningTokens.toLocaleString()]);
    }
    if (u.cost != null) rows.push(["コスト", `$${u.cost.toFixed(6)}`]);
  }
  if (message.createdAt) {
    rows.push(["時刻", new Date(message.createdAt).toLocaleString("ja-JP")]);
  }
  if (durationMs != null) {
    rows.push(["所要時間", `${(durationMs / 1000).toFixed(1)}秒`]);
  }
  if (tokensPerSec) rows.push(["速度", `${tokensPerSec} tok/秒`]);
  if (rows.length === 0) return null;

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="詳細"
        title="この応答の詳細"
        className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-600 group-hover/msg:text-gray-400 dark:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300 dark:group-hover/msg:text-gray-500"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <span className="absolute bottom-7 left-0 z-40 block w-64 rounded-xl border border-gray-200 bg-white p-3 text-xs shadow-lg dark:border-gray-700 dark:bg-gray-900">
            {rows.map(([k, v]) => (
              <span key={k} className="flex justify-between gap-3 py-0.5">
                <span className="shrink-0 text-gray-400 dark:text-gray-500">{k}</span>
                <span className="break-all text-right text-gray-700 dark:text-gray-200">{v}</span>
              </span>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

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
  initialParams = null,
  emptyState,
}: {
  conversationId: string | null;
  initialMessages: UiMessage[];
  bot?: BotContext | null;
  initialModel?: string | null;
  /** この会話の生成パラメータ（会話 or ボットのスナップショット）。 */
  initialParams?: ParamsState | null;
  emptyState?: React.ReactNode;
}) {
  const { models, openSidebar } = useOutletContext<ShellContext>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [model, setModel] = useState(initialModel ?? DEFAULT_MODEL);
  const [webSearch, setWebSearch] = useState(false);
  const [params, setParams] = useState<ParamsState>(
    initialParams ?? bot?.params ?? {},
  );
  const [paramsOpen, setParamsOpen] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(
    null,
  );
  /** 削除選択モード。null = 通常表示。 */
  const [selecting, setSelecting] = useState<Set<string> | null>(null);

  // 新規チャットで送信した時点で会話IDが確定するため ref で保持する
  const convIdRef = useRef<string | null>(conversationId);
  // スマートスクロール: 最下部付近にいるときだけ自動追従する
  const stickToBottomRef = useRef(true);
  const paramsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 古い非同期処理が新しいストリームの表示を上書きしないための世代カウンタ
  const epochRef = useRef(0);

  useEffect(() => {
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

  // 別端末やリロードで開いたとき、生成中の応答があればポーリングで追いかける
  useEffect(() => {
    const last = initialMessages[initialMessages.length - 1];
    if (last?.status === "streaming" && last.id && conversationId) {
      const epoch = ++epochRef.current;
      setIsStreaming(true);
      void pollUntilDone(conversationId, last.id, epoch).then(() => {
        if (epochRef.current === epoch) {
          setIsStreaming(false);
          void refreshPath(conversationId, epoch);
        }
      });
    }
    // 初回マウント時のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectModel = (id: string) => {
    setModel(id);
    localStorage.setItem(MODEL_STORAGE_KEY, id);
    if (convIdRef.current) {
      void fetch(`/api/conversations/${convIdRef.current}`, {
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

  /** ⚙パネルでの変更を反映し、既存の会話にはデバウンスして保存する。 */
  const changeParams = (next: ParamsState) => {
    setParams(next);
    const convId = convIdRef.current;
    if (!convId) return;
    if (paramsSaveTimer.current) clearTimeout(paramsSaveTimer.current);
    paramsSaveTimer.current = setTimeout(() => {
      void fetch(`/api/conversations/${convId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params: next }),
      }).catch(() => {});
    }, 600);
  };

  const resetParams = () => {
    if (
      !confirm(
        "生成パラメータを初期設定（すべて自動 = モデル既定値）に戻します。よろしいですか？",
      )
    ) {
      return;
    }
    changeParams({});
  };

  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [messages]);

  // スマホではプレースホルダを短縮する
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  /** 現在のパスをサーバーから取り直す（ページャ・usage・状態の更新）。 */
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

  /** 最後のアシスタントメッセージをサーバーの状態で置き換える。 */
  function applyRemoteState(remote: {
    content: string;
    reasoning: string | null;
    status: string;
    error: string | null;
    usage: UiMessage["usage"] | null;
  }) {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role !== "assistant") return prev;
      next[next.length - 1] = {
        ...last,
        content: remote.content,
        reasoning: remote.reasoning ?? undefined,
        status: remote.status === "done" ? undefined : (remote.status as UiMessage["status"]),
        error: remote.error ?? undefined,
        usage: remote.usage ?? last.usage,
      };
      return next;
    });
  }

  /** 生成中メッセージをポーリングで追いかける（生成完了で返る）。 */
  async function pollUntilDone(convId: string, messageId: string, epoch: number) {
    for (;;) {
      if (epochRef.current !== epoch) return;
      try {
        const res = await fetch(
          `/api/conversations/${convId}/messages/${messageId}`,
        );
        if (!res.ok) return;
        const remote = (await res.json()) as {
          content: string;
          reasoning: string | null;
          status: string;
          error: string | null;
          usage: UiMessage["usage"] | null;
        };
        if (epochRef.current !== epoch) return;
        applyRemoteState(remote);
        if (remote.status !== "streaming") return;
      } catch {
        // 一時的な失敗はリトライ
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  /**
   * 生成を開始する。生成はサーバー（Durable Object）側で進行・保存され、
   * このクライアントはポーリングで表示を追いかけるだけ。
   * リロード・別端末・タブ閉じのどれにも影響されない。
   */
  async function runGeneration(
    history: UiMessage[],
    persistInfo: { parentId: string | null; userContent: string | null },
  ) {
    setError(null);
    setIsStreaming(true);
    const epoch = ++epochRef.current;

    try {
      // 新規チャットなら先に会話を作る
      let convId = convIdRef.current;
      let isNew = false;
      if (!convId) {
        const firstUser = history.find((m) => m.role === "user");
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelId: model,
            botId: bot?.id ?? undefined,
            params: Object.keys(params).length > 0 ? params : undefined,
            title: (firstUser?.content ?? "新しいチャット").slice(0, 40),
          }),
        });
        if (!res.ok) throw new Error("会話の作成に失敗しました");
        convId = ((await res.json()) as { id: string }).id;
        convIdRef.current = convId;
        isNew = true;
        revalidator.revalidate(); // サイドバーに即反映
      }

      setMessages([
        ...history,
        { role: "assistant", content: "", status: "streaming" },
      ]);

      const res = await fetch(`/api/conversations/${convId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          web: webSearch,
          params,
          parentId: persistInfo.parentId,
          userContent: persistInfo.userContent,
          messages: [
            ...(bot?.systemPrompt
              ? [{ role: "system", content: bot.systemPrompt }]
              : []),
            ...history.map(({ role, content }) => ({ role, content })),
          ],
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `エラーが発生しました (${res.status})`);
      }

      const { userMessageId, assistantMessageId } = (await res.json()) as {
        userMessageId: string | null;
        assistantMessageId: string;
      };

      // サーバーが採番したIDをローカル状態へ反映
      setMessages((prev) => {
        const next = [...prev];
        const asst = next[next.length - 1];
        if (asst?.role === "assistant") {
          next[next.length - 1] = { ...asst, id: assistantMessageId };
        }
        if (userMessageId) {
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "user" && !next[i].id) {
              next[i] = { ...next[i], id: userMessageId };
              break;
            }
          }
        }
        return next;
      });

      // 生成過程・最終状態はサーバーを正とし、ポーリングで追いかける
      await pollUntilDone(convId, assistantMessageId, epoch);

      if (epochRef.current === epoch) {
        setIsStreaming(false);
        if (isNew) {
          // タイトル生成 → 会話ページへ
          const finalRes = await fetch(
            `/api/conversations/${convId}/messages/${assistantMessageId}`,
          ).catch(() => null);
          const finalBody = finalRes?.ok
            ? ((await finalRes.json()) as { content: string })
            : null;
          if (persistInfo.userContent && finalBody?.content) {
            await fetch(`/api/conversations/${convId}/title`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                userText: persistInfo.userContent,
                assistantText: finalBody.content,
              }),
            }).catch(() => {});
          }
          await navigate(`/chat/${convId}`, { replace: true });
        } else {
          await refreshPath(convId, epoch);
          revalidator.revalidate();
        }
      }
    } catch (e) {
      if (epochRef.current === epoch) {
        setError((e as Error).message);
        setIsStreaming(false);
        // 開始できなかった場合は空のプレースホルダを取り除く
        setMessages((prev) =>
          prev[prev.length - 1]?.role === "assistant" &&
          prev[prev.length - 1].content === "" &&
          prev[prev.length - 1].status === "streaming"
            ? prev.slice(0, -1)
            : prev,
        );
      }
    }
  }

  function send() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    stickToBottomRef.current = true; // 送信時は必ず最下部へ
    const parentId = messages[messages.length - 1]?.id ?? null;
    void runGeneration([...messages, { role: "user", content: text }], {
      parentId,
      userContent: text,
    });
  }

  function stop() {
    const convId = convIdRef.current;
    const last = messages[messages.length - 1];
    if (!convId || !last?.id || last.role !== "assistant") return;
    void fetch(`/api/conversations/${convId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: last.id }),
    }).catch(() => {});
  }

  function regenerate() {
    if (isStreaming) return;
    const history = [...messages];
    while (history.length > 0 && history[history.length - 1].role === "assistant") {
      history.pop();
    }
    if (history.length === 0) return;
    void runGeneration(history, {
      parentId: history[history.length - 1]?.id ?? null,
      userContent: null,
    });
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
    void runGeneration(history, {
      parentId: messages[editing.index - 1]?.id ?? null,
      userContent: text,
    });
  }

  /** 削除選択モードでの選択トグル。 */
  function toggleSelect(id: string | undefined) {
    if (!id) return;
    setSelecting((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 選択したメッセージを一括削除する。 */
  async function deleteSelected() {
    const convId = convIdRef.current;
    if (!convId || !selecting || selecting.size === 0) return;
    if (
      !confirm(
        `選択した${selecting.size}件のメッセージを削除します。この操作は取り消せません。よろしいですか？`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/conversations/${convId}/delete-messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selecting] }),
      });
      if (!res.ok) throw new Error();
      const { messages: fresh } = (await res.json()) as {
        messages: UiMessage[];
      };
      setMessages(fresh);
      setSelecting(null);
      revalidator.revalidate();
    } catch {
      setError("メッセージの削除に失敗しました。");
      setSelecting(null);
    }
  }

  /** ブランチ切替（ページャ）。 */
  async function switchBranch(targetId: string) {
    const convId = convIdRef.current;
    if (isStreaming || !convId) return;
    try {
      const res = await fetch(`/api/conversations/${convId}/path`, {
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
    const convId = convIdRef.current;
    if (isStreaming || !convId) return;
    if (
      !confirm(
        "ここまでの履歴をコピーして、独立した新しい会話を作成します。よろしいですか？",
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/conversations/${convId}/fork`, {
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

  const lastMessage = messages[messages.length - 1];

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
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => setParamsOpen((v) => !v)}
            aria-label="生成パラメータ"
            title="生成パラメータ（この会話にのみ適用）"
            className={`rounded-lg p-2 ${
              Object.keys(params).length > 0
                ? "text-indigo-500 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950"
                : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            }`}
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.113a7.047 7.047 0 010 2.228l1.267 1.113a1 1 0 01.206 1.25l-1.18 2.045a1 1 0 01-1.187.447l-1.598-.54a6.993 6.993 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447l-1.18-2.044a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.227L1.821 7.773a1 1 0 01-.206-1.25l1.18-2.045a1 1 0 011.187-.447l1.598.54A6.993 6.993 0 017.51 3.456l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </header>

      {paramsOpen && (
        <div className="fixed inset-0 z-20" onClick={() => setParamsOpen(false)}>
          <div
            className="absolute right-2 top-14 max-h-[70vh] w-[min(94vw,26rem)] overflow-y-auto rounded-2xl border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">生成パラメータ</p>
              <button
                type="button"
                onClick={resetParams}
                className="rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                初期設定に戻す
              </button>
            </div>
            <p className="mb-3 text-xs text-gray-400 dark:text-gray-500">
              この会話にのみ適用されます
              {bot ? "（ボットの設定が初期状態です）" : ""}
            </p>
            <ParamsEditor
              model={models.find((m) => m.id === model)}
              value={params}
              onChange={changeParams}
            />
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-3xl px-4 py-6">
          {messages.length === 0 && (
            <div className="flex min-h-[60vh] items-center justify-center text-gray-300 dark:text-gray-600">
              {emptyState ?? (
                <p className="text-lg">モデルを選んでメッセージを送信</p>
              )}
            </div>
          )}
          <div className="space-y-6">
            {messages.map((m, i) => {
              const selectable = selecting != null && m.id != null;
              const selectionClass = selecting
                ? `cursor-pointer rounded-xl px-2 py-1 -mx-2 ${
                    m.id && selecting.has(m.id)
                      ? "bg-indigo-50 ring-1 ring-indigo-300 dark:bg-indigo-950/40 dark:ring-indigo-700"
                      : "hover:bg-gray-50 dark:hover:bg-gray-900"
                  }`
                : "";
              return m.role === "user" ? (
                <div
                  key={m.id ?? `u${i}`}
                  className={`group/msg ${selectionClass}`}
                  onClick={selectable ? () => toggleSelect(m.id) : undefined}
                >
                  {editing?.index === i ? (
                    <div className="rounded-2xl border border-indigo-300 bg-gray-50 p-3 dark:border-indigo-700 dark:bg-gray-900">
                      <textarea
                        value={editing.text}
                        onChange={(e) =>
                          setEditing({ index: i, text: e.target.value })
                        }
                        rows={3}
                        autoFocus
                        translate="no"
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
                      {!selecting && (
                        <div className="mt-1 flex items-center justify-end gap-1.5">
                          <BranchPager
                            message={m}
                            disabled={isStreaming}
                            onSwitch={switchBranch}
                          />
                          <CopyButton text={m.content} />
                          {m.id && !isStreaming && (
                            <>
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
                              <button
                                type="button"
                                onClick={() => setSelecting(new Set([m.id!]))}
                                aria-label="削除"
                                title="メッセージを削除（選択モードへ）"
                                className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-red-600 group-hover/msg:text-gray-400 dark:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-red-400 dark:group-hover/msg:text-gray-500"
                              >
                                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                                  <path
                                    fillRule="evenodd"
                                    d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div
                  key={m.id ?? `a${i}`}
                  className={`group/msg ${selectionClass}`}
                  onClick={selectable ? () => toggleSelect(m.id) : undefined}
                >
                  {m.reasoning && (
                    <ReasoningBlock
                      key={`r${m.id ?? i}`}
                      reasoning={m.reasoning}
                      streaming={
                        isStreaming && i === messages.length - 1 && !m.content
                      }
                    />
                  )}
                  {m.status === "error" ? (
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                      <span className="break-all">
                        {m.error ?? "生成に失敗しました"}
                      </span>
                      {i === messages.length - 1 && !isStreaming && (
                        <button
                          type="button"
                          onClick={regenerate}
                          className="shrink-0 rounded-lg border border-red-300 px-3 py-1 hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900"
                        >
                          再試行
                        </button>
                      )}
                    </div>
                  ) : (
                    <Markdown>{m.content}</Markdown>
                  )}
                  {isStreaming && i === messages.length - 1 && (
                    <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-gray-400 align-text-bottom dark:bg-gray-500" />
                  )}
                  {!selecting && (
                    <div className="mt-1 flex items-center gap-2">
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
                      <CopyButton text={m.content} />
                      <MessageDetails message={m} />
                      {m.id && !isStreaming && m.status !== "error" && (
                        <button
                          type="button"
                          onClick={() => void fork(m.id!)}
                          title="ここから分岐（独立した新しい会話を作成）"
                          className="rounded px-1.5 py-0.5 text-xs text-gray-300 hover:bg-gray-100 hover:text-gray-600 group-hover/msg:text-gray-400 dark:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300 dark:group-hover/msg:text-gray-500"
                        >
                          ⑂ ここから分岐
                        </button>
                      )}
                      {m.id && !isStreaming && (
                        <button
                          type="button"
                          onClick={() => setSelecting(new Set([m.id!]))}
                          aria-label="削除"
                          title="メッセージを削除（選択モードへ）"
                          className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-red-600 group-hover/msg:text-gray-400 dark:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-red-400 dark:group-hover/msg:text-gray-500"
                        >
                          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                            <path
                              fillRule="evenodd"
                              d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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
            lastMessage?.role === "assistant" &&
            lastMessage.status !== "error" && (
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
        {selecting ? (
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {selecting.size}件選択中（メッセージをタップで選択/解除）
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSelecting(null)}
                className="rounded-xl px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void deleteSelected()}
                disabled={selecting.size === 0}
                className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-30"
              >
                削除
              </button>
            </div>
          </div>
        ) : (
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
            translate="no"
            placeholder={
              isNarrow ? "メッセージ" : "メッセージを入力…（Shift+Enterで改行）"
            }
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
        )}
      </footer>
    </div>
  );
}
