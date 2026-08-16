import { startTransition, useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext, useRevalidator } from "react-router";
import type { ShellContext } from "../routes/shell";
import type { UiAttachment, UiMessage } from "../lib/types";
import { type ParamsState } from "../lib/params";
import { recordModelUse } from "../lib/recent-models";
import {
  readRetryConfig,
  RETRY_CONCURRENCY_KEY,
  RETRY_DEFAULT_MAX_ATTEMPTS,
  RETRY_DEFAULT_TARGET,
  RETRY_ENABLED_KEY,
  RETRY_MAX_KEY,
  RETRY_TARGET_KEY,
} from "../lib/retry";
import {
  ACCEPTED_IMAGE_TYPES,
  formatBytes,
  isAcceptedImage,
  prepareImage,
} from "../lib/image";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import { ParamsEditor } from "./ParamsEditor";
import { NumberInput } from "./NumberInput";
import { Lightbox } from "./Lightbox";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconCopy,
  IconGlobe,
  IconInfo,
  IconMenu,
  IconPencil,
  IconPlus,
  IconSliders,
  IconTrash,
  IconX,
} from "./icons";
import { GLASS_PANEL } from "../lib/ui";

/** この会話に適用されるボット設定（会話開始時のスナップショット）。 */
export interface BotContext {
  id: string | null;
  name: string;
  icon: string;
  systemPrompt: string | null;
  params: ParamsState | null;
}

const MODEL_STORAGE_KEY = "chat-webui:model";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const POLL_INTERVAL_MS = 500;
/** リトライ生成の追跡間隔。途中経過が無いので長めにする。 */
const RUN_POLL_INTERVAL_MS = 1500;
/**
 * Web検索（OpenRouterの :online プラグイン）の設定キー。
 * 他の生成パラメータと同じく会話の params に保存するが、APIへは送らず
 * （buildGenerationPayload はプロバイダごとの許可リストしか読まない）、
 * generate リクエストの web フラグとしてだけ使う。
 * キーが無い = 既定でオン。"off" のときだけ無効。
 */
const WEB_PARAM_KEY = "web";
/** 1メッセージに添付できる画像の枚数（サーバー側の上限と揃える）。 */
const MAX_ATTACHMENTS = 8;

/** 円建てコストの表示。額の大きさに応じて桁数を変える。 */
function formatJpy(jpy: number): string {
  if (jpy >= 100) return `¥${Math.round(jpy).toLocaleString()}`;
  if (jpy >= 1) return `¥${jpy.toFixed(2)}`;
  return `¥${jpy.toFixed(4)}`;
}

/** 送信前の添付。アップロード完了で id（添付ID）が入る。 */
interface PendingAttachment {
  localId: string;
  previewUrl: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  id?: string;
  error?: string;
}

/** メッセージに添付された画像の表示（タップで原寸表示）。 */
function MessageImages({
  attachments,
  onOpen,
}: {
  attachments: UiAttachment[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="mb-1.5 flex flex-wrap items-end justify-end gap-1.5">
      {attachments.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onOpen(a.id)}
          title={a.name ?? "画像"}
          className="overflow-hidden rounded-xl border border-neutral-200 transition hover:opacity-90 active:scale-[0.98] dark:border-neutral-700"
        >
          <img
            src={`/api/files/${a.id}`}
            alt={a.name ?? "添付画像"}
            loading="lazy"
            className="max-h-56 max-w-[min(16rem,60vw)] object-contain"
          />
        </button>
      ))}
    </div>
  );
}

/** 「成功するまで生成」の数値入力1つ分。空欄なら既定に従う。 */
function RetryField({
  label,
  hint,
  value,
  effective,
  min,
  max,
  onChange,
  onClear,
}: {
  label: string;
  hint: string;
  /** 実際に入力されている値。未入力なら undefined。 */
  value: number | undefined;
  /** 未入力のときに使われる値（プレースホルダに出す）。 */
  effective: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        <p className="truncate text-xs text-neutral-400 dark:text-neutral-500">
          {hint}
        </p>
      </div>
      <NumberInput
        label={label}
        value={value}
        onChange={onChange}
        onClear={onClear}
        placeholder={String(effective)}
        min={min}
        max={max}
        step={1}
        className="w-20 shrink-0 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-right text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
      />
    </div>
  );
}

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
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
      >
        <span aria-hidden>💭</span>
        {streaming ? "思考中…" : show ? "思考プロセスを隠す" : "思考プロセスを表示"}
      </button>
      {show && (
        <div className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl border border-neutral-100 bg-neutral-50 px-3 py-2 text-xs leading-relaxed text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
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
      className="rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 dark:group-hover/msg:text-neutral-500"
    >
      {copied ? (
        <IconCheck className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <IconCopy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/** 応答の詳細情報（トークン・金額・時刻・所要時間・速度）のポップオーバー。 */
function MessageDetails({
  message,
  usdJpy,
}: {
  message: UiMessage;
  usdJpy: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const u = message.usage;
  const durationMs =
    message.finishedAt && message.createdAt
      ? message.finishedAt - message.createdAt
      : null;
  const tokensPerSec =
    durationMs && durationMs > 0 && u && u.completionTokens != null
      ? (u.completionTokens / (durationMs / 1000)).toFixed(1)
      : null;

  const rows: [string, string][] = [];
  if (message.modelId) rows.push(["モデル", message.modelId]);
  if (u) {
    if (u.promptTokens != null) {
      rows.push(["入力トークン", u.promptTokens.toLocaleString()]);
    }
    if (u.cachedTokens != null && u.cachedTokens > 0) {
      rows.push([
        "うちキャッシュ読取",
        `${u.cachedTokens.toLocaleString()}（割引適用）`,
      ]);
    }
    if (u.completionTokens != null) {
      rows.push(["出力トークン", u.completionTokens.toLocaleString()]);
    }
    if (u.reasoningTokens != null && u.reasoningTokens > 0) {
      rows.push(["うち思考トークン", u.reasoningTokens.toLocaleString()]);
    }
    if (u.points != null) {
      rows.push(["消費ポイント", `${u.points.toLocaleString()} pt`]);
    }
    if (u.cost != null) {
      // 一覧は円建てのみ、詳細では円とドルを併記する
      rows.push([
        "コスト",
        usdJpy != null
          ? `${formatJpy(u.cost * usdJpy)}（$${u.cost.toFixed(6)}）`
          : `$${u.cost.toFixed(6)}`,
      ]);
    }
  }
  if (message.createdAt) {
    rows.push(["時刻", new Date(message.createdAt).toLocaleString("ja-JP")]);
  }
  if (durationMs != null) {
    rows.push(["所要時間", `${(durationMs / 1000).toFixed(1)}秒`]);
  }
  if (tokensPerSec) rows.push(["速度", `${tokensPerSec} tok/秒`]);
  if (rows.length === 0) return null;

  /**
   * パネルはボタン上に fixed 配置し、左端を画面内へクランプする。
   * メッセージ列内の absolute 配置だと、スマホでボタンが右寄りのとき
   * パネルが画面外へはみ出し、ページ全体が横スクロール可能になっていた。
   */
  const PANEL_WIDTH = 256; // w-64
  const openPanel = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const margin = 8;
      setPos({
        left: Math.max(
          margin,
          Math.min(rect.left, window.innerWidth - PANEL_WIDTH - margin),
        ),
        bottom: window.innerHeight - rect.top + 6,
      });
    }
    setOpen(true);
  };

  return (
    <span className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-label="詳細"
        title="この応答の詳細"
        className="rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 dark:group-hover/msg:text-neutral-500"
      >
        <IconInfo className="h-3.5 w-3.5" />
      </button>
      {open && pos && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <span
            style={{ left: pos.left, bottom: pos.bottom }}
            className={`fixed z-40 block w-64 origin-bottom rounded-xl p-3 text-xs animate-pop ${GLASS_PANEL}`}
          >
            {rows.map(([k, v]) => (
              <span key={k} className="flex justify-between gap-3 py-0.5">
                <span className="shrink-0 text-neutral-400 dark:text-neutral-500">{k}</span>
                <span className="break-all text-right text-neutral-700 dark:text-neutral-200">{v}</span>
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
    <span className="inline-flex items-center gap-0.5 text-xs text-neutral-400 dark:text-neutral-500">
      <button
        type="button"
        disabled={disabled || siblingIndex === 0}
        onClick={() => onSwitch(siblingIds[siblingIndex - 1])}
        className="rounded px-1 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
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
        className="rounded px-1 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        aria-label="次のブランチ"
      >
        ›
      </button>
    </span>
  );
}

/** 遷移直後にまず描画する末尾のメッセージ数。残りは直後に低優先度で描く。 */
const DEFERRED_TAIL = 24;

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
  const { models, usdJpy, settings, openSidebar } =
    useOutletContext<ShellContext>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [model, setModel] = useState(initialModel ?? DEFAULT_MODEL);
  const [params, setParams] = useState<ParamsState>(
    initialParams ?? bot?.params ?? {},
  );
  const [paramsOpen, setParamsOpen] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  // 未送信の下書きを端末に保存する（リロード・ページ遷移後に復元）
  const draftKey = `chat-webui:draft:${conversationId ?? "new"}`;
  /** 未送信の添付。本文と同じく端末に残し、画面の作り直しでも失わない。 */
  const attachKey = `chat-webui:draft-files:${conversationId ?? "new"}`;
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 編集して再送信の状態。attachments は編集後のメッセージに付く添付
   * （既存分 + 追加分。削除も可能）。uploads は追加分のアップロード
   * 進行中件数で、0になるまで送信できない。
   */
  const [editing, setEditing] = useState<{
    index: number;
    text: string;
    attachments: UiAttachment[];
    uploads: number;
  } | null>(null);
  /** 削除選択モード。null = 通常表示。 */
  const [selecting, setSelecting] = useState<Set<string> | null>(null);
  /**
   * コンテンツがヘッダー下に潜り込んでいるか。
   * 最上部ではヘッダーを完全透明にしてページと一体化させ、
   * スクロールしたときだけガラス面と境界線を出す（iOSアプリと同じ挙動）。
   */
  const [scrolled, setScrolled] = useState(false);
  /** 最下部付近にいるか。離れているときだけ「最新へ」を出す。 */
  const [atBottom, setAtBottom] = useState(true);
  /** 送信前の添付画像。 */
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  /** ドラッグ&ドロップのハイライト。 */
  const [dragOver, setDragOver] = useState(false);
  /** 原寸表示中の添付ID。 */
  const [lightbox, setLightbox] = useState<string | null>(null);
  /**
   * 「成功するまで生成」の実行確認待ち。
   * 何度も生成する＝そのぶん課金されるので、走り出す前にパラメータを見せる。
   */
  const [pendingRun, setPendingRun] = useState<(() => void) | null>(null);

  // 新規チャットで送信した時点で会話IDが確定するため ref で保持する
  const convIdRef = useRef<string | null>(conversationId);
  // スマートスクロール: 最下部付近にいるときだけ自動追従する
  const stickToBottomRef = useRef(true);

  /**
   * 遷移直後の初回描画は末尾だけにして、画面が出たらすぐ
   * startTransition で全件に広げる（スクロールは待たない）。
   * 低優先度の割り込み可能なレンダリングなので、広げている最中に
   * スクロールやタップが来てもそちらが先に処理される。
   */
  const [renderAll, setRenderAll] = useState(
    initialMessages.length <= DEFERRED_TAIL,
  );
  useEffect(() => {
    if (renderAll) return;
    startTransition(() => setRenderAll(true));
    // 初回マウント時のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // 全件に広がると上に内容が増える。最下部に貼り付いていたなら貼り直す
    if (renderAll && stickToBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderAll]);
  const paramsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ガラス面フッターの高さ（コンテンツ下部の余白に使う）
  const footerRef = useRef<HTMLElement>(null);
  const [footerHeight, setFooterHeight] = useState(88);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);
  // ドラッグの出入りは子要素をまたぐたびに発火するため、深さで数える
  const dragDepth = useRef(0);
  // アンマウント時にプレビュー用のオブジェクトURLを解放するための最新値
  const pendingRef = useRef<PendingAttachment[]>([]);
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
  }, [models, initialModel]);

  /** この会話を既読にする（一覧の未読マークを落とす）。 */
  function markRead(convId: string) {
    void fetch(`/api/conversations/${convId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    }).catch(() => {});
  }

  // 開いた時点で既読にする（見ている会話に印が残らないように）
  useEffect(() => {
    if (conversationId) markRead(conversationId);
    // 会話を切り替えたときも
  }, [conversationId]);

  // 別端末やリロードで開いたとき、生成中の応答があればポーリングで追いかける
  useEffect(() => {
    const last = initialMessages[initialMessages.length - 1];
    if (last?.status === "streaming" && last.id && conversationId) {
      const epoch = ++epochRef.current;
      setIsStreaming(true);
      void pollUntilDone(conversationId, last.id, epoch).then(() => {
        if (epochRef.current === epoch) {
          setIsStreaming(false);
          markRead(conversationId);
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

  /**
   * Web検索の有効/無効。既定はオンで、オフにしたときだけ
   * 会話パラメータに "off" を保存する（他のパラメータと同じ保存経路）。
   * Poeには相当機能がないため、Poeモデルでは常に無効扱い。
   */
  const webSearch = params[WEB_PARAM_KEY] !== "off";
  const toggleWebSearch = () => {
    const next = { ...params };
    if (webSearch) next[WEB_PARAM_KEY] = "off";
    else delete next[WEB_PARAM_KEY];
    changeParams(next);
  };

  /** ⚙パネルに出す、実際に入力されている値（未入力は undefined）。 */
  const retryValue = (key: string): number | undefined => {
    const raw = params[key];
    if (raw == null || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  /** null を渡すと未入力に戻す（既定値に従う）。 */
  const setRetryParam = (key: string, value: number | null) => {
    const next = { ...params };
    if (value == null) delete next[key];
    else next[key] = value;
    changeParams(next);
  };

  /** 「成功するまで生成」の有効/無効。既定値も同時に置く。 */
  const toggleRetry = () => {
    const next = { ...params };
    if (retryConfig) {
      delete next[RETRY_ENABLED_KEY];
    } else {
      next[RETRY_ENABLED_KEY] = "on";
      next[RETRY_TARGET_KEY] ??= RETRY_DEFAULT_TARGET;
      next[RETRY_MAX_KEY] ??= Math.min(
        RETRY_DEFAULT_MAX_ATTEMPTS,
        settings.retryAttemptCeiling,
      );
    }
    changeParams(next);
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

  // 下書きの復元（マウント時のみ）。ボットを選ぶとこの画面は作り直され、
  // リロードでも状態は消えるため、本文と一緒に添付も戻す
  useEffect(() => {
    const draft = localStorage.getItem(draftKey);
    if (draft) setInput(draft);
    try {
      const saved = JSON.parse(
        localStorage.getItem(attachKey) ?? "[]",
      ) as { id: string; name: string; size: number }[];
      const restored = saved
        .filter((a) => a && typeof a.id === "string")
        .slice(0, MAX_ATTACHMENTS)
        .map(
          (a): PendingAttachment => ({
            localId: crypto.randomUUID(),
            previewUrl: `/api/files/${a.id}`,
            name: a.name ?? "画像",
            size: Number(a.size) || 0,
            status: "ready",
            id: a.id,
          }),
        );
      if (restored.length > 0) setPending(restored);
    } catch {
      // 壊れていれば無視する
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // アップロードが終わった添付だけを控える（送信すると破棄する）
  useEffect(() => {
    const ready = pending
      .filter((p) => p.status === "ready" && p.id)
      .map((p) => ({ id: p.id!, name: p.name, size: p.size }));
    try {
      if (ready.length > 0) {
        localStorage.setItem(attachKey, JSON.stringify(ready));
      } else {
        localStorage.removeItem(attachKey);
      }
    } catch {
      // 保存できなくても添付自体は使える
    }
  }, [pending, attachKey]);

  // フッター（ガラス面）の高さを測り、コンテンツ下部の余白に反映する
  useEffect(() => {
    const el = footerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setFooterHeight(el.offsetHeight));
    observer.observe(el);
    setFooterHeight(el.offsetHeight);
    return () => observer.disconnect();
  }, []);

  // スマホではプレースホルダを短縮する
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // 入力欄の高さを内容に合わせる（入力時・下書き復元時・
  // プレースホルダ切替時をカバー。空のときは最小高さに任せる）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (input) el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input, isNarrow]);

  const changeInput = (value: string) => {
    setInput(value);
    try {
      if (value) localStorage.setItem(draftKey, value);
      else localStorage.removeItem(draftKey);
    } catch {
      // ストレージ不可でも入力自体は妨げない
    }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = near;
    setAtBottom(near);
    setScrolled(el.scrollTop > 8);
  };

  /** 「最新へ」。押した時点から追従も再開する。 */
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // --- 添付画像 -----------------------------------------------------------

  const visibleMessages = renderAll
    ? messages
    : messages.slice(-DEFERRED_TAIL);
  const hiddenCount = messages.length - visibleMessages.length;

  const selectedModel = models.find((m) => m.id === model);
  /**
   * 「成功するまで生成」。セーフティ判定の揺らぎで弾かれた依頼を
   * 投げ直すためのものなので、画像を出せるモデルのときだけ出す
   * （テキストは成功の判定ができない）。
   */
  const canRetry = selectedModel?.outputModalities.includes("image") ?? false;
  const retryConfig = canRetry
    ? readRetryConfig(params, settings.retryAttemptCeiling)
    : null;
  /** 画像入力に対応したモデルか。Poeも supports_images を返すので同じ扱い。 */
  const supportsImages =
    !selectedModel || selectedModel.inputModalities.includes("image");

  /** 選択・貼り付け・ドロップされた画像を縮小してアップロードする。 */
  async function addFiles(files: File[]) {
    const images = files.filter(isAcceptedImage);
    if (images.length === 0) {
      if (files.length > 0) setError("画像ファイルのみ添付できます。");
      return;
    }
    const room = MAX_ATTACHMENTS - pending.length;
    if (room <= 0) {
      setError(`添付は1メッセージあたり${MAX_ATTACHMENTS}枚までです。`);
      return;
    }
    setError(null);

    for (const file of images.slice(0, room)) {
      const localId = crypto.randomUUID();
      const entry: PendingAttachment = {
        localId,
        previewUrl: URL.createObjectURL(file),
        name: file.name,
        size: file.size,
        status: "uploading",
      };
      setPending((prev) => [...prev, entry]);

      void (async () => {
        try {
          const prepared = await prepareImage(file);
          const form = new FormData();
          form.append("file", prepared);
          const res = await fetch("/api/uploads", {
            method: "POST",
            body: form,
          });
          const body = (await res.json().catch(() => null)) as
            | { id?: string; size?: number; error?: string }
            | null;
          if (!res.ok || !body?.id) {
            throw new Error(body?.error ?? `アップロードに失敗しました (${res.status})`);
          }
          setPending((prev) =>
            prev.map((p) =>
              p.localId === localId
                ? { ...p, status: "ready", id: body.id, size: body.size ?? p.size }
                : p,
            ),
          );
        } catch (e) {
          setPending((prev) =>
            prev.map((p) =>
              p.localId === localId
                ? { ...p, status: "error", error: (e as Error).message }
                : p,
            ),
          );
        }
      })();
    }
  }

  /**
   * 生成画像を入力欄の添付に載せる（編集・リスタイル・合成の起点）。
   *
   * 生成画像はモデルへ送り返せない（アシスタントの発言に画像を付ける形式が
   * OpenAI互換APIに無い）。編集対象は「最新のユーザーメッセージの添付」
   * として渡す決まりなので、次の発言へ引き継げるようにする。
   * 実体はR2にあるためアップロードは不要で、添付IDをそのまま使う。
   */
  function attachGeneratedImages(attachments: UiAttachment[]) {
    setPending((prev) => {
      const room = MAX_ATTACHMENTS - prev.length;
      if (room <= 0) {
        setError(`添付は1メッセージあたり${MAX_ATTACHMENTS}枚までです。`);
        return prev;
      }
      const added = attachments
        .filter((a) => !prev.some((p) => p.id === a.id))
        .slice(0, room)
        .map(
          (a): PendingAttachment => ({
            localId: crypto.randomUUID(),
            previewUrl: `/api/files/${a.id}`,
            name: a.name ?? "生成画像",
            size: a.size,
            status: "ready",
            id: a.id,
          }),
        );
      return added.length > 0 ? [...prev, ...added] : prev;
    });
    setError(null);
    textareaRef.current?.focus();
  }

  function removePending(localId: string) {
    setPending((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  }

  /**
   * 編集中メッセージへの画像追加。縮小 → アップロードし、完了したものから
   * editing.attachments に加える（表示は /api/files/:id 経由）。
   */
  async function addEditFiles(files: File[]) {
    const current = editing;
    if (!current) return;
    const room =
      MAX_ATTACHMENTS - current.attachments.length - current.uploads;
    const images = files.filter(isAcceptedImage).slice(0, Math.max(0, room));
    if (images.length === 0) {
      if (files.length > 0 && room <= 0) {
        setError(`添付は1メッセージあたり${MAX_ATTACHMENTS}枚までです。`);
      }
      return;
    }
    setEditing((prev) =>
      prev ? { ...prev, uploads: prev.uploads + images.length } : prev,
    );
    for (const file of images) {
      try {
        const prepared = await prepareImage(file);
        const form = new FormData();
        form.append("file", prepared);
        const res = await fetch("/api/uploads", { method: "POST", body: form });
        const body = (await res.json().catch(() => null)) as
          | { id?: string; mimeType?: string; name?: string | null; size?: number; error?: string }
          | null;
        if (!res.ok || !body?.id) {
          throw new Error(body?.error ?? `アップロードに失敗しました (${res.status})`);
        }
        setEditing((prev) =>
          prev
            ? {
                ...prev,
                uploads: prev.uploads - 1,
                attachments: [
                  ...prev.attachments,
                  {
                    id: body.id!,
                    mimeType: body.mimeType ?? "image/*",
                    name: body.name ?? file.name,
                    size: body.size ?? file.size,
                  },
                ],
              }
            : prev,
        );
      } catch (e) {
        setEditing((prev) =>
          prev ? { ...prev, uploads: prev.uploads - 1 } : prev,
        );
        setError((e as Error).message);
      }
    }
  }

  pendingRef.current = pending;
  useEffect(() => {
    return () => {
      for (const p of pendingRef.current) URL.revokeObjectURL(p.previewUrl);
    };
  }, []);

  const uploading = pending.some((p) => p.status === "uploading");
  const readyAttachmentIds = pending
    .filter((p) => p.status === "ready" && p.id)
    .map((p) => p.id!);

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  /** 入力欄への画像貼り付け（スクショの直接添付）。 */
  function onPaste(e: React.ClipboardEvent) {
    const files = [...e.clipboardData.files];
    if (files.some(isAcceptedImage)) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  /** 現在のパスをサーバーから取り直す（ページャ・usage・状態の更新）。 */
  /**
   * リトライ生成の追跡。成功するたびに応答が増えるので、
   * 1件を見張るのではなくパスごと取り直す。
   * 画像生成には途中経過が無いため、間隔は長めでよい。
   */
  async function pollRunUntilDone(convId: string, epoch: number) {
    for (;;) {
      if (epochRef.current !== epoch) return;
      try {
        const res = await fetch(`/api/conversations/${convId}/path`);
        if (res.ok) {
          const { messages: fresh } = (await res.json()) as {
            messages: UiMessage[];
          };
          if (epochRef.current !== epoch) return;
          setMessages(fresh);
          if (!fresh.some((m) => m.status === "streaming")) return;
        }
      } catch {
        // 一時的な失敗はリトライ
      }
      await new Promise((r) => setTimeout(r, RUN_POLL_INTERVAL_MS));
    }
  }

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
    persistInfo: {
      parentId: string | null;
      userContent: string | null;
      /** 新しいユーザーメッセージに添付する画像（アップロード済みの添付ID）。 */
      userAttachmentIds?: string[];
    },
  ) {
    setError(null);
    setIsStreaming(true);
    const epoch = ++epochRef.current;
    // モデルピッカーの「最近よく使うモデル」の材料。選択ではなく実際に
    // 生成へ使ったときだけ数える
    recordModelUse(model);

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
            title: (firstUser?.content?.trim() || "新しいチャット").slice(0, 40),
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
          web: webSearch && !model.startsWith("poe:"),
          imageOutput: selectedModel?.outputModalities.includes("image") ?? false,
          params,
          parentId: persistInfo.parentId,
          userContent: persistInfo.userContent,
          userAttachmentIds: persistInfo.userAttachmentIds ?? [],
          messages: [
            ...(bot?.systemPrompt
              ? [{ role: "system", content: bot.systemPrompt }]
              : []),
            // 画像を送るのはユーザーの発言だけ。生成画像もアシスタントの
            // メッセージに紐づくが、応答に画像を差し戻す形式は
            // OpenAI互換APIに無く、送ると弾かれる
            ...history.map(({ role, content, attachments }) => ({
              role,
              content,
              attachmentIds:
                role === "user" ? attachments?.map((a) => a.id) : undefined,
            })),
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
      if (retryConfig) {
        await pollRunUntilDone(convId, epoch);
      } else {
        await pollUntilDone(convId, assistantMessageId, epoch);
      }
      // 見届けたので既読に戻す（確定時に未読が立つ）
      markRead(convId);

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
          if (persistInfo.userContent != null && finalBody?.content) {
            await fetch(`/api/conversations/${convId}/title`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                // 画像だけの送信でもタイトルは付けたいので、本文が空なら補う
                userText: persistInfo.userContent.trim() || "（画像を送信）",
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

  function send(confirmed = false) {
    if (retryConfig && !confirmed) {
      setPendingRun(() => () => send(true));
      return;
    }
    const text = input.trim();
    // 画像だけの送信も許す。アップロード中は完了を待つ
    if ((!text && readyAttachmentIds.length === 0) || isStreaming || uploading) {
      return;
    }
    const attachments: UiAttachment[] = pending
      .filter((p) => p.status === "ready" && p.id)
      .map((p) => ({
        id: p.id!,
        mimeType: "image/*",
        name: p.name,
        size: p.size,
      }));
    const attachmentIds = attachments.map((a) => a.id);

    setInput("");
    localStorage.removeItem(draftKey); // 送信したら下書きは破棄
    localStorage.removeItem(attachKey);
    // プレビューURLは以降 /api/files/:id で表示するため解放してよい
    for (const p of pending) URL.revokeObjectURL(p.previewUrl);
    setPending([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    stickToBottomRef.current = true; // 送信時は必ず最下部へ
    const parentId = messages[messages.length - 1]?.id ?? null;
    void runGeneration(
      [
        ...messages,
        {
          role: "user",
          content: text,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
      ],
      { parentId, userContent: text, userAttachmentIds: attachmentIds },
    );
  }

  function stop() {
    const convId = convIdRef.current;
    // リトライ生成では末尾が完了済みの応答なので、生成中の行を探す
    const target = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.id && m.status === "streaming");
    if (!convId || !target?.id) return;
    void fetch(`/api/conversations/${convId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: target.id }),
    }).catch(() => {});
  }

  /**
   * 最後尾がユーザーメッセージのとき（分岐直後や応答削除後）、
   * 新しい入力なしでそのまま応答を生成する。
   */
  function generateFromLast(confirmed = false) {
    if (isStreaming) return;
    if (retryConfig && !confirmed) {
      setPendingRun(() => () => generateFromLast(true));
      return;
    }
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user" || !last.id) return;
    void runGeneration([...messages], {
      parentId: last.id,
      userContent: null,
    });
  }

  function regenerate(confirmed = false) {
    if (isStreaming) return;
    if (retryConfig && !confirmed) {
      setPendingRun(() => () => regenerate(true));
      return;
    }
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
  function submitEdit(confirmed = false) {
    if (!editing || isStreaming || editing.uploads > 0) return;
    if (retryConfig && !confirmed) {
      setPendingRun(() => () => submitEdit(true));
      return;
    }
    const text = editing.text.trim();
    const attachments = editing.attachments;
    if (!text && attachments.length === 0) return;
    const history = [
      ...messages.slice(0, editing.index),
      {
        role: "user" as const,
        content: text,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
    ];
    setEditing(null);
    void runGeneration(history, {
      parentId: messages[editing.index - 1]?.id ?? null,
      userContent: text,
      userAttachmentIds: attachments.map((a) => a.id),
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
    <div
      className="relative h-full"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        void addFiles([...e.dataTransfer.files]);
      }}
    >
      <header
        className={`absolute inset-x-0 top-0 z-20 flex items-center gap-1 border-b px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] transition-colors duration-200 ${
          scrolled
            ? "border-neutral-200/60 bg-white/60 backdrop-blur-xl backdrop-saturate-150 dark:border-white/10 dark:bg-neutral-950/55"
            : "border-transparent"
        }`}
      >
        <button
          type="button"
          onClick={openSidebar}
          aria-label="メニュー"
          className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 md:hidden dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <IconMenu className="h-5 w-5" />
        </button>
        {bot && (
          <span
            className="flex min-w-0 shrink items-center gap-1.5 rounded-lg bg-neutral-100 px-2.5 py-1.5 text-sm font-medium dark:bg-neutral-800"
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
                ? "text-accent hover:bg-accent/10"
                : "text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            }`}
          >
            <IconSliders className="h-5 w-5" />
          </button>
        </div>
      </header>

      {paramsOpen && (
        <div className="fixed inset-0 z-20" onClick={() => setParamsOpen(false)}>
          <div
            className={`absolute right-2 top-[calc(3.5rem+env(safe-area-inset-top))] max-h-[70vh] w-[min(94vw,26rem)] origin-top-right overflow-y-auto rounded-2xl p-4 animate-pop ${GLASS_PANEL}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-baseline gap-2">
                <p className="text-sm font-semibold">生成パラメータ</p>
                {/* 対応パラメータも送信形式もプロバイダで異なるため明示する */}
                {selectedModel && (
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                    {selectedModel.provider === "poe" ? "Poe" : "OpenRouter"}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={resetParams}
                className="rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                初期設定に戻す
              </button>
            </div>
            <p className="mb-3 text-xs text-neutral-400 dark:text-neutral-500">
              この会話にのみ適用されます
              {bot ? "（ボットの設定が初期状態です）" : ""}
            </p>
            {!model.startsWith("poe:") && (
              <div className="mb-3 flex items-center gap-3 rounded-xl border border-neutral-200/80 p-3 dark:border-white/10">
                <IconGlobe className="h-5 w-5 shrink-0 text-neutral-400 dark:text-neutral-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Web検索</p>
                  <p className="text-xs text-neutral-400 dark:text-neutral-500">
                    最新情報を検索して回答（検索1回ごとに数円の追加料金）
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={webSearch}
                  aria-label="Web検索"
                  onClick={toggleWebSearch}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    webSearch
                      ? "bg-accent"
                      : "bg-neutral-300 dark:bg-neutral-600"
                  }`}
                >
                  <span
                    className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                      webSearch ? "translate-x-[22px]" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            )}
            {canRetry && (
              <div className="mb-3 rounded-xl border border-neutral-200/80 p-3 dark:border-white/10">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">成功するまで生成</p>
                    <p className="text-xs text-neutral-400 dark:text-neutral-500">
                      画像が返るまで同じ依頼を投げ直す（拒否の揺らぎ対策）
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={retryConfig != null}
                    aria-label="成功するまで生成"
                    onClick={toggleRetry}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      retryConfig
                        ? "bg-accent"
                        : "bg-neutral-300 dark:bg-neutral-600"
                    }`}
                  >
                    <span
                      className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                        retryConfig ? "translate-x-[22px]" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
                {retryConfig && (
                  <div className="mt-2 space-y-1.5 border-t border-neutral-100 pt-2 dark:border-white/10">
                    <RetryField
                      label="目標の成功数"
                      hint="ほしい応答の数"
                      value={retryValue(RETRY_TARGET_KEY)}
                      effective={retryConfig.target}
                      min={1}
                      max={settings.retryAttemptCeiling}
                      onChange={(v) => setRetryParam(RETRY_TARGET_KEY, v)}
                      onClear={() => setRetryParam(RETRY_TARGET_KEY, null)}
                    />
                    <RetryField
                      label="上限の試行回数"
                      hint={`未入力なら目標数と同じ（天井: ${settings.retryAttemptCeiling}）`}
                      value={retryValue(RETRY_MAX_KEY)}
                      effective={retryConfig.maxAttempts}
                      min={1}
                      max={settings.retryAttemptCeiling}
                      onChange={(v) => setRetryParam(RETRY_MAX_KEY, v)}
                      onClear={() => setRetryParam(RETRY_MAX_KEY, null)}
                    />
                    <RetryField
                      label="並列数"
                      hint="同時に走らせる数。未入力なら目標数と同じ"
                      value={retryValue(RETRY_CONCURRENCY_KEY)}
                      effective={retryConfig.concurrency}
                      min={1}
                      max={retryConfig.maxAttempts}
                      onChange={(v) => setRetryParam(RETRY_CONCURRENCY_KEY, v)}
                      onClear={() => setRetryParam(RETRY_CONCURRENCY_KEY, null)}
                    />
                  </div>
                )}
              </div>
            )}
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
        className="absolute inset-0 overflow-y-auto overscroll-contain"
      >
        <div
          className="mx-auto max-w-3xl px-4 pt-[calc(5rem+env(safe-area-inset-top))]"
          style={{ paddingBottom: footerHeight + 24 }}
        >
          {messages.length === 0 && (
            <div className="flex min-h-[60vh] items-center justify-center text-neutral-300 dark:text-neutral-600">
              {emptyState ?? (
                <p className="text-lg">モデルを選んでメッセージを送信</p>
              )}
            </div>
          )}
          <div className="space-y-6">
            {visibleMessages.map((m, vi) => {
              const i = vi + hiddenCount;
              const selectable = selecting != null && m.id != null;
              const selectionClass = selecting
                ? `cursor-pointer rounded-xl px-2 py-1 -mx-2 ${
                    m.id && selecting.has(m.id)
                      ? "bg-accent/10 ring-1 ring-accent/50"
                      : "hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  }`
                : "";
              return m.role === "user" ? (
                <div
                  key={m.id ?? `u${i}`}
                  className={`group/msg ${selectionClass}`}
                  onClick={selectable ? () => toggleSelect(m.id) : undefined}
                >
                  {editing?.index === i ? (
                    <div className="rounded-2xl border border-accent/50 bg-neutral-50 p-3 dark:bg-neutral-900">
                      {(editing.attachments.length > 0 || editing.uploads > 0) && (
                        <div className="mb-2 flex flex-wrap gap-2">
                          {editing.attachments.map((a) => (
                            <div
                              key={a.id}
                              className="group/att relative h-16 w-16 overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-700"
                              title={a.name ?? "画像"}
                            >
                              <img
                                src={`/api/files/${a.id}`}
                                alt={a.name ?? "添付画像"}
                                className="h-full w-full object-cover"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  setEditing((prev) =>
                                    prev
                                      ? {
                                          ...prev,
                                          attachments: prev.attachments.filter(
                                            (x) => x.id !== a.id,
                                          ),
                                        }
                                      : prev,
                                  )
                                }
                                aria-label="添付を削除"
                                className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-xs text-white opacity-0 transition group-hover/att:opacity-100 focus:opacity-100 max-sm:opacity-100"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          {Array.from({ length: editing.uploads }).map((_, n) => (
                            <div
                              key={`up${n}`}
                              className="grid h-16 w-16 place-items-center rounded-xl border border-neutral-200 dark:border-neutral-700"
                            >
                              <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-accent" />
                            </div>
                          ))}
                        </div>
                      )}
                      <textarea
                        value={editing.text}
                        onChange={(e) =>
                          setEditing((prev) =>
                            prev ? { ...prev, text: e.target.value } : prev,
                          )
                        }
                        onPaste={(e) => {
                          const files = [...e.clipboardData.files];
                          if (files.some(isAcceptedImage)) {
                            e.preventDefault();
                            void addEditFiles(files);
                          }
                        }}
                        rows={3}
                        autoFocus
                        translate="no"
                        className="w-full resize-y bg-transparent outline-none"
                      />
                      <div className="mt-2 flex items-center gap-2 text-sm">
                        <input
                          ref={editFileInputRef}
                          type="file"
                          accept={ACCEPTED_IMAGE_TYPES.join(",")}
                          multiple
                          hidden
                          onChange={(e) => {
                            void addEditFiles([...(e.target.files ?? [])]);
                            e.target.value = "";
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => editFileInputRef.current?.click()}
                          disabled={
                            editing.attachments.length + editing.uploads >=
                            MAX_ATTACHMENTS
                          }
                          aria-label="画像を追加"
                          title="画像を追加"
                          className="grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-800"
                        >
                          <IconPlus className="h-4.5 w-4.5" />
                        </button>
                        <div className="ml-auto flex gap-2">
                          <button
                            type="button"
                            onClick={() => setEditing(null)}
                            className="rounded-lg px-3 py-1.5 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                          >
                            キャンセル
                          </button>
                          <button
                            type="button"
                            onClick={() => submitEdit()}
                            disabled={
                              (!editing.text.trim() &&
                                editing.attachments.length === 0) ||
                              editing.uploads > 0
                            }
                            title={
                              editing.uploads > 0
                                ? "画像をアップロード中…"
                                : "送信"
                            }
                            className="rounded-lg bg-accent px-3 py-1.5 text-accent-fg hover:bg-accent/85 disabled:opacity-30"
                          >
                            送信
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      {m.attachments && m.attachments.length > 0 && (
                        <MessageImages
                          attachments={m.attachments}
                          onOpen={setLightbox}
                        />
                      )}
                      {m.content && (
                        <div className="flex justify-end">
                          <div className="max-w-[85%] min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-3xl rounded-br-lg bg-accent px-4 py-2.5 text-accent-fg">
                            {m.content}
                          </div>
                        </div>
                      )}
                      {!selecting && (
                        <div className="mt-1 flex items-center justify-end gap-1.5">
                          <BranchPager
                            message={m}
                            disabled={isStreaming}
                            onSwitch={switchBranch}
                          />
                          {m.content && <CopyButton text={m.content} />}
                          {m.id && !isStreaming && (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  setEditing({
                                    index: i,
                                    text: m.content,
                                    attachments: m.attachments ?? [],
                                    uploads: 0,
                                  })
                                }
                                aria-label="編集して再送信"
                                title="編集して再送信（分岐を作成）"
                                className="rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 dark:group-hover/msg:text-neutral-500"
                              >
                                <IconPencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void fork(m.id!)}
                                title="ここから分岐（独立した新しい会話を作成）"
                                className="rounded px-1.5 py-0.5 text-xs text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 dark:group-hover/msg:text-neutral-500"
                              >
                                ⑂ ここから分岐
                              </button>
                              <button
                                type="button"
                                onClick={() => setSelecting(new Set([m.id!]))}
                                aria-label="削除"
                                title="メッセージを削除（選択モードへ）"
                                className="rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-red-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-red-400 dark:group-hover/msg:text-neutral-500"
                              >
                                <IconTrash className="h-3.5 w-3.5" />
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
                          onClick={() => regenerate()}
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
                    <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-neutral-400 align-text-bottom dark:bg-neutral-500" />
                  )}
                  {!selecting && (
                    <div className="mt-1 flex items-center gap-2">
                      <BranchPager
                        message={m}
                        disabled={isStreaming}
                        onSwitch={switchBranch}
                      />
                      {m.usage && (
                        <span className="text-xs text-neutral-400 dark:text-neutral-500">
                          {m.usage.promptTokens != null &&
                            `${m.usage.promptTokens} in / ${m.usage.completionTokens ?? 0} out`}
                          {m.usage.points != null &&
                            `${m.usage.promptTokens != null ? " · " : ""}${m.usage.points.toLocaleString()} pt`}
                          {m.usage.cost != null &&
                            ` · ${
                              usdJpy != null
                                ? formatJpy(m.usage.cost * usdJpy)
                                : `$${m.usage.cost.toFixed(6)}`
                            }`}
                        </span>
                      )}
                      <CopyButton text={m.content} />
                      <MessageDetails message={m} usdJpy={usdJpy} />
                      {m.attachments && m.attachments.length > 0 && (
                        <button
                          type="button"
                          onClick={() => attachGeneratedImages(m.attachments!)}
                          title="この画像を入力欄に添付して、編集や続きを頼む"
                          className="rounded px-1.5 py-0.5 text-xs text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 dark:group-hover/msg:text-neutral-500"
                        >
                          この画像を使う
                        </button>
                      )}
                      {m.id && !isStreaming && m.status !== "error" && (
                        <button
                          type="button"
                          onClick={() => void fork(m.id!)}
                          title="ここから分岐（独立した新しい会話を作成）"
                          className="rounded px-1.5 py-0.5 text-xs text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 dark:group-hover/msg:text-neutral-500"
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
                          className="rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-red-600 group-hover/msg:text-neutral-400 dark:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-red-400 dark:group-hover/msg:text-neutral-500"
                        >
                          <IconTrash className="h-3.5 w-3.5" />
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
                onClick={() => regenerate()}
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
                  onClick={() => regenerate()}
                  className="rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                >
                  ↻ 再生成
                </button>
              </div>
            )}

          {/* 分岐直後・応答削除後など、最後尾がユーザーメッセージのとき */}
          {!isStreaming &&
            !error &&
            !selecting &&
            lastMessage?.role === "user" &&
            lastMessage.id && (
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => generateFromLast()}
                  className="rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10"
                >
                  ↵ 応答を生成
                </button>
              </div>
            )}
        </div>
      </div>

      {/*
        コンポーザー: ChatGPT風の一体型ガラスピル。
        フッター自体は透明グラデーションにし、ピルだけが浮いて見えるようにする。
      */}
      {!atBottom && messages.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="最新のメッセージへ"
          title="最新のメッセージへ"
          className={`absolute left-1/2 z-20 -translate-x-1/2 rounded-full p-2 text-neutral-500 animate-pop dark:text-neutral-300 ${GLASS_PANEL}`}
          style={{ bottom: footerHeight + 12 }}
        >
          <IconArrowDown className="h-5 w-5" />
        </button>
      )}

      <footer
        ref={footerRef}
        className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-white via-white/80 to-transparent px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-6 dark:from-neutral-950 dark:via-neutral-950/80"
      >
        {selecting ? (
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-3xl border border-neutral-200/80 bg-white/85 px-4 py-2.5 shadow-lg shadow-black/5 backdrop-blur-xl backdrop-saturate-150 dark:border-white/10 dark:bg-neutral-900/80">
            <span className="text-sm text-neutral-500 dark:text-neutral-400">
              {selecting.size}件選択中（メッセージをタップで選択/解除）
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSelecting(null)}
                className="rounded-xl px-4 py-2 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
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
          <div className="mx-auto max-w-3xl">
            <div className="rounded-[1.625rem] border border-neutral-200/80 bg-white/85 shadow-lg shadow-black/5 backdrop-blur-xl backdrop-saturate-150 transition-colors focus-within:border-neutral-300 dark:border-white/10 dark:bg-neutral-900/80 dark:focus-within:border-white/20">
              {pending.length > 0 && (
                <div className="flex flex-wrap gap-2 px-3 pt-3">
                  {pending.map((p) => (
                    <div
                      key={p.localId}
                      className={`group/att relative h-16 w-16 overflow-hidden rounded-xl border ${
                        p.status === "error"
                          ? "border-red-300 dark:border-red-800"
                          : "border-neutral-200 dark:border-neutral-700"
                      }`}
                      title={
                        p.status === "error"
                          ? p.error
                          : `${p.name}（${formatBytes(p.size)}）`
                      }
                    >
                      <img
                        src={p.previewUrl}
                        alt={p.name}
                        className={`h-full w-full object-cover ${
                          p.status === "ready" ? "" : "opacity-40"
                        }`}
                      />
                      {p.status === "uploading" && (
                        <span className="absolute inset-0 grid place-items-center">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-accent" />
                        </span>
                      )}
                      {p.status === "error" && (
                        <span className="absolute inset-0 grid place-items-center text-lg text-red-500">
                          !
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => removePending(p.localId)}
                        aria-label="添付を削除"
                        className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-xs text-white opacity-0 transition group-hover/att:opacity-100 focus:opacity-100 max-sm:opacity-100"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {pending.length > 0 && !supportsImages && (
                <p className="px-4 pt-2 text-xs text-amber-600 dark:text-amber-400">
                  このモデルは画像入力に対応していません。画像は無視されるか、エラーになる場合があります。
                </p>
              )}
              <div className="flex items-end gap-1 p-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_IMAGE_TYPES.join(",")}
                  multiple
                  hidden
                  onChange={(e) => {
                    void addFiles([...(e.target.files ?? [])]);
                    e.target.value = ""; // 同じファイルの再選択を許す
                  }}
                />
                <button
                  type="button"
                  onClick={openFilePicker}
                  disabled={pending.length >= MAX_ATTACHMENTS}
                  title={
                    supportsImages
                      ? "画像を添付（貼り付け・ドラッグ&ドロップも可）"
                      : "このモデルは画像入力に対応していません（添付は可能ですが無視されます）"
                  }
                  aria-label="画像を添付"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-neutral-100 active:scale-90 disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-white/10"
                >
                  <IconPlus className="h-5 w-5" />
                </button>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => changeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  onPaste={onPaste}
                  rows={1}
                  translate="no"
                  placeholder={
                    isNarrow ? "メッセージ" : "メッセージを入力…（Shift+Enterで改行）"
                  }
                  className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-1.5 leading-6 outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                />
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={stop}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition hover:bg-accent/85 active:scale-90"
                    aria-label="停止"
                  >
                    <span className="block h-3 w-3 rounded-[3px] bg-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => send()}
                    disabled={
                      (!input.trim() && readyAttachmentIds.length === 0) ||
                      uploading
                    }
                    title={uploading ? "画像をアップロード中…" : "送信"}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition hover:bg-accent/85 active:scale-90 disabled:opacity-30"
                    aria-label="送信"
                  >
                    <IconArrowUp className="h-4.5 w-4.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </footer>

      {dragOver && (
        <div className="pointer-events-none absolute inset-3 z-40 grid animate-fade place-items-center rounded-3xl border-2 border-dashed border-accent/60 bg-accent/10 text-sm font-medium text-accent backdrop-blur-sm">
          画像をドロップして添付
        </div>
      )}

      {pendingRun && retryConfig && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setPendingRun(null)}
        >
          <div
            className={`w-full max-w-sm rounded-2xl p-4 animate-pop ${GLASS_PANEL}`}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold">成功するまで生成します</p>
            <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
              画像が返るまで同じ依頼を投げ直します。試行のたびに課金されます。
            </p>
            <dl className="mt-3 space-y-1.5 rounded-xl border border-neutral-200/80 p-3 text-sm dark:border-white/10">
              <div className="flex justify-between gap-3">
                <dt className="text-neutral-500 dark:text-neutral-400">
                  目標の成功数
                </dt>
                <dd className="font-medium">{retryConfig.target}件</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-neutral-500 dark:text-neutral-400">
                  上限の試行回数
                </dt>
                <dd className="font-medium">{retryConfig.maxAttempts}回</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-neutral-500 dark:text-neutral-400">
                  並列数
                </dt>
                <dd className="font-medium">{retryConfig.concurrency}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-neutral-500 dark:text-neutral-400">
                  モデル
                </dt>
                <dd className="min-w-0 truncate font-medium">
                  {selectedModel?.name ?? model}
                </dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
              最大 {retryConfig.maxAttempts}回ぶんの生成が行われます。並列数が
              目標を超える場合、成功が目標より多くなることがあります（受け取ります）。
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingRun(null)}
                className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => {
                  const run = pendingRun;
                  setPendingRun(null);
                  run();
                }}
                className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent/85"
              >
                実行
              </button>
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <Lightbox id={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
