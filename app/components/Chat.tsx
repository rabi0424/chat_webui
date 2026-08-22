import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useOutletContext, useRevalidator } from "react-router";
import type { ShellContext } from "../routes/shell";
import type { UiAttachment, UiMessage } from "../lib/types";
import {
  DEFAULT_MODEL,
  MAX_ATTACHMENTS_PER_MESSAGE as MAX_ATTACHMENTS,
  MAX_TITLE_LENGTH,
} from "../lib/constants";
import {
  PULL_IGNORE_SELECTOR,
  PULL_MAX_PX,
  PULL_REST_PX,
  PULL_SLOP_PX,
  PULL_TRIGGER_PX,
} from "../lib/pull-to-refresh";
import { type ParamsState } from "../lib/params";
import { recordModelUse } from "../lib/recent-models";
import { invalidateChat } from "../lib/chat-cache";
import { readRetryConfig } from "../lib/retry";
import { isAcceptedImage } from "../lib/image";
import { ModelPicker } from "./ModelPicker";
import { ParamsEditor } from "./ParamsEditor";
import { RetrySettings } from "./RetrySettings";
import { Lightbox } from "./Lightbox";
import { useGenerationTracking } from "./chat/use-generation-tracking";
import {
  useAttachments,
  uploadImage,
  type PendingAttachment,
} from "./chat/use-attachments";
import { type EditingState } from "./chat/MessageEditor";
import {
  MessageList,
  BOUNDARY_SELECT_PREFIX,
} from "./chat/MessageList";
import { Composer } from "./chat/Composer";
import { LiveRegion } from "./chat/LiveRegion";
import { SelectionBar } from "./chat/SelectionBar";
import { type MessageActions } from "./chat/message-context";
import { useEscapeToClose } from "../lib/dismiss";
import type {
  CreateConversationResponse,
  ErrorResponse,
  GenerateResponse,
  PathResponse,
} from "../lib/api-types";
import {
  IconArrowDown,
  IconGlobe,
  IconMenu,
  IconSliders,
} from "./icons";
import { GLASS_PANEL, scrollBehavior } from "../lib/ui";

/** この会話に適用されるボット設定（会話開始時のスナップショット）。 */
export interface BotContext {
  id: string | null;
  name: string;
  icon: string;
  systemPrompt: string | null;
  params: ParamsState | null;
}

const MODEL_STORAGE_KEY = "chat-webui:model";

/* 引っぱって更新の寸法は lib/pull-to-refresh.ts に集約（画像一覧と共通） */

/**
 * Web検索（OpenRouterの :online プラグイン）の設定キー。
 * 他の生成パラメータと同じく会話の params に保存するが、APIへは送らず
 * （buildGenerationPayload はプロバイダごとの許可リストしか読まない）、
 * generate リクエストの web フラグとしてだけ使う。
 * キーが無い = 既定でオン。"off" のときだけ無効。
 */
const WEB_PARAM_KEY = "web";
/**
 * モデルへ送る履歴を、コンテキストの境界線で切り落とす。
 *
 * 境界線が立ったメッセージまで（それ自身を含む）は送らない。複数ある
 * ときは最後のものが効く。履歴の表示は一切変えず、送る範囲だけを狭める。
 */
function contextWindow(history: UiMessage[]): UiMessage[] {
  let start = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].contextBoundary) start = i + 1;
  }
  return start === 0 ? history : history.slice(start);
}

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
  /**
   * 未送信の下書きを端末に保存する（リロード・ページ遷移後に復元）。
   *
   * 新規チャットは会話IDが無いので "new" を使うが、最初の送信でIDが
   * 決まったあともこの画面は作り直されない。props の conversationId を
   * そのまま見ていると "new" のまま書き続け、2通目を打ちかけたまま
   * 遷移すると（読む側は会話IDのキーを見るので）消えたように見え、
   * 次に開いた新規チャットには無関係な下書きが出てきていた。
   */
  const [draftScope, setDraftScope] = useState(conversationId ?? "new");
  const draftKey = `chat-webui:draft:${draftScope}`;
  /** 未送信の添付。本文と同じく端末に残し、画面の作り直しでも失わない。 */
  const attachKey = `chat-webui:draft-files:${draftScope}`;
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 分岐直後などの控えめなトースト。数秒で自動的に消える。 */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 編集して再送信の状態。attachments は編集後のメッセージに付く添付
   * （既存分 + 追加分。削除も可能）。uploads は追加分のアップロード
   * 進行中件数で、0になるまで送信できない。
   */
  const [editing, setEditing] = useState<EditingState | null>(null);
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
  /** 引っぱって更新の実行中。 */
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  refreshingRef.current = refreshing;
  /** 送信前の添付画像。 */
  const {
    pending,
    setPending,
    addFiles,
    attachGeneratedImages,
    removePending,
  } = useAttachments({
    setError,
    onAttached: () => textareaRef.current?.focus(),
  });
  /** ドラッグ&ドロップのハイライト。 */
  const [dragOver, setDragOver] = useState(false);
  /** 原寸表示中の添付ID。 */
  const [lightbox, setLightbox] = useState<string | null>(null);
  /**
   * 「成功するまで生成」の実行確認待ち。
   * 何度も生成する＝そのぶん課金されるので、走り出す前にパラメータを見せる。
   */
  const [pendingRun, setPendingRun] = useState<(() => void) | null>(null);

  /** 数秒で消えるトーストを出す（続けて出しても前のタイマーは畳む）。 */
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  };
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const location = useLocation();
  useEffect(() => {
    if ((location.state as { forked?: boolean } | null)?.forked) {
      showNotice("⑂ 分岐を作成しました");
    }
    // 分岐直後のマウント時のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  /** 引っぱって更新: 指の動きに合わせて動かす要素（再描画せずに触る）。 */
  const feedRef = useRef<HTMLDivElement>(null);
  const spinnerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);
  // ドラッグの出入りは子要素をまたぐたびに発火するため、深さで数える
  const dragDepth = useRef(0);
  // アンマウント時にプレビュー用のオブジェクトURLを解放するための最新値
  const pendingRef = useRef<PendingAttachment[]>([]);
  // 古い非同期処理が新しいストリームの表示を上書きしないための世代カウンタ
  const {
    startTracking,
    alive,
    pollUntilDone,
    pollRunUntilDone,
    refreshPath,
    trackRunning,
  } = useGenerationTracking({ setMessages, setIsStreaming, markRead });

  /**
   * 会話IDが決まったので、下書きの置き場をその会話へ移す。
   *
   * 送信の直後に呼ばれる。送信ぶんの本文は既に消してあるが、返事を
   * 待つあいだに打ち始めた続きが "new" に残っていることがあるので、
   * 一緒に移し替える（残すと次の新規チャットに出てきてしまう）。
   */
  function adoptDraftScope(convId: string) {
    const move = (prefix: string) => {
      try {
        const from = `${prefix}:new`;
        const value = localStorage.getItem(from);
        if (value === null) return;
        localStorage.setItem(`${prefix}:${convId}`, value);
        localStorage.removeItem(from);
      } catch {
        // 端末の保存が使えなくても、この画面のあいだは入力欄が持っている
      }
    };
    move("chat-webui:draft");
    move("chat-webui:draft-files");
    setDraftScope(convId);
  }

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
    if (conversationId) trackRunning(conversationId, initialMessages);
    // 初回マウント時のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectModel = (id: string) => {
    setModel(id);
    localStorage.setItem(MODEL_STORAGE_KEY, id);
    if (convIdRef.current) {
      // 先読みキャッシュにも会話のモデルが入っている。捨てておかないと
      // 別の会話へ移って60秒以内に戻ったとき、選択が巻き戻って見える
      invalidateChat(convIdRef.current);
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

  /** ⚙パネルでの変更を反映し、既存の会話にはデバウンスして保存する。 */
  const changeParams = (next: ParamsState) => {
    setParams(next);
    const convId = convIdRef.current;
    if (!convId) return;
    invalidateChat(convId); // モデルと同じ理由（巻き戻って見えるのを防ぐ）
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

  // 本文が動いたら先読みキャッシュを無効化（古いスナップショットで再訪させない）
  useEffect(() => {
    if (convIdRef.current) invalidateChat(convIdRef.current);
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

  /** 表示が伸びたときの追従（最下部に貼り付いているときだけ）。 */
  const followBottom = () => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = near;
    setAtBottom(near);
    setScrolled(el.scrollTop > 8);
  };

  /** 引っぱり量をそのまま画面へ（再描画を挟まずDOMを直に動かす）。 */
  const paintPull = (distance: number, animated: boolean) => {
    const feed = feedRef.current;
    const spinner = spinnerRef.current;
    const ease = animated
      ? "transform 0.25s ease-out, opacity 0.25s ease-out"
      : "none";
    if (feed) {
      feed.style.transition = ease;
      feed.style.transform = distance > 0 ? `translateY(${distance}px)` : "";
    }
    if (spinner) {
      spinner.style.transition = ease;
      spinner.style.opacity = String(Math.min(1, distance / PULL_TRIGGER_PX));
      spinner.style.transform = `translateY(${distance}px) rotate(${distance * 2.4}deg)`;
    }
  };

  /**
   * 引っぱって更新: 会話フィードをサーバーから取り直す。
   * 別の端末・別のタブで進んだ内容や、通信が途切れて取りこぼした
   * 続きをここで拾い直せる。
   */
  async function pullRefresh() {
    const convId = convIdRef.current;
    if (!convId || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    invalidateChat(convId); // 先読みキャッシュも作り直させる
    const started = performance.now();
    try {
      const res = await fetch(`/api/conversations/${convId}/path`);
      if (res.ok) {
        const { messages: fresh } = (await res.json()) as PathResponse;
        /*
         * まだサーバーに無いメッセージが画面にある間は差し替えない。
         *
         * 送信した直後は、保存が終わるまで楽観表示のユーザー発言と
         * プレースホルダがIDを持たずに並んでいる。ここでサーバーの
         * パスに置き換えるとそれらが消え、あとから届いたIDが別の
         * メッセージに付いて、前の応答の本文が新しい応答で上書き
         * されて見える。取り直しは次の機会に回せばよい。
         */
        let replaced = false;
        setMessages((prev) => {
          if (prev.some((m) => !m.id)) return prev;
          replaced = true;
          return fresh;
        });
        if (replaced) {
          setError(null);
          // 別の画面で走っている生成があれば、ここから追いかける
          if (!isStreaming) trackRunning(convId, fresh);
        }
      }
    } catch {
      // 取り直せなくても、いま出ている内容はそのまま残す
    }
    // 一瞬で消えると更新されたのか分からないので、印は少しだけ見せる
    const rest = 450 - (performance.now() - started);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
    setRefreshing(false);
  }

  const pullRefreshRef = useRef(pullRefresh);
  pullRefreshRef.current = pullRefresh;

  /**
   * 最上部から下へ引っぱったら更新する（iOSアプリと同じ操作）。
   * touchmove は React 経由だと passive 扱いで preventDefault できないため、
   * ここで直接ぶら下げる。指に追従する部分は再描画せずDOMを直に動かす。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !conversationId) return;
    let startY = 0;
    let pulled = 0;
    let active = false;

    // 遊びを超えて初めて「引っぱり」に切り替える（それまではタップ扱い）
    let engaged = false;

    const onStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement | null;
      active =
        el.scrollTop <= 0 &&
        e.touches.length === 1 &&
        !refreshingRef.current &&
        // ボタンや入力欄の上から始まった指は、最初から引っぱりに使わない
        !target?.closest(PULL_IGNORE_SELECTOR);
      startY = e.touches[0]?.clientY ?? 0;
      pulled = 0;
      engaged = false;
    };
    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const dy = (e.touches[0]?.clientY ?? 0) - startY;
      if (dy <= 0 || el.scrollTop > 0) {
        // 上向き・途中からのスクロールは通常のスクロールに任せる
        if (pulled > 0) paintPull(0, true);
        active = false;
        engaged = false;
        pulled = 0;
        return;
      }
      // 遊びの内側はまだ何もしない。ここで preventDefault すると
      // 指がわずかにぶれただけのタップが click を失う
      if (!engaged) {
        if (dy < PULL_SLOP_PX) return;
        engaged = true;
      }
      // 引っぱるほど重くなるゴムの手ざわり（遊びぶんは差し引く）
      pulled = Math.min(PULL_MAX_PX, (dy - PULL_SLOP_PX) * 0.5);
      paintPull(pulled, false);
      if (e.cancelable) e.preventDefault();
    };
    const onEnd = () => {
      if (!active) return;
      active = false;
      engaged = false;
      const triggered = pulled >= PULL_TRIGGER_PX;
      pulled = 0;
      // 更新するときは、終わるまで印を出したまま少し下げておく
      paintPull(triggered ? PULL_REST_PX : 0, true);
      if (triggered) void pullRefreshRef.current();
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [conversationId]);

  // 更新中は印を出したままにし、終わったら元の位置へ戻す
  useEffect(() => {
    paintPull(refreshing ? PULL_REST_PX : 0, true);
  }, [refreshing]);

  /**
   * いま読んでいる位置を覚え、描き直しのあとに戻す関数を返す。
   *
   * 一覧の差し替え（コンテキストクリアの付け外しなど）で行が増減すると、
   * 見ていた場所から飛ばされることがある。最下部に貼り付いていたなら
   * 最下部へ、そうでなければ元の位置へ戻す。
   */
  const captureScroll = () => {
    const wasAtBottom = stickToBottomRef.current;
    const top = scrollRef.current?.scrollTop ?? 0;
    return () => {
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = wasAtBottom ? el.scrollHeight : top;
      });
    };
  };

  /** 「最新へ」。押した時点から追従も再開する。 */
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
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
  /**
   * この応答が画像を出しにいくか。生成中に経過秒を出すかの判断に使う。
   *
   * 画像生成は本文が流れてこないので、待っているあいだ画面に動きがなく、
   * どれだけ待ったのかも分からない。応答ごとに使ったモデルは違いうるので、
   * メッセージに記録されたモデルを優先し、無ければ今の選択を使う
   * （送信直後のまだIDが付いていないプレースホルダ用）。
   */
  const isImageGeneration = (modelId: string | undefined) =>
    models
      .find((mm) => mm.id === (modelId ?? model))
      ?.outputModalities.includes("image") ?? false;

  /** 画像入力に対応したモデルか。Poeも supports_images を返すので同じ扱い。 */
  const supportsImages =
    !selectedModel || selectedModel.inputModalities.includes("image");

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
        // 入力欄からの追加と同じ手順（縮小 → アップロード）を使う
        const uploaded = await uploadImage(file);
        setEditing((prev) =>
          prev
            ? {
                ...prev,
                uploads: prev.uploads - 1,
                attachments: [...prev.attachments, uploaded],
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
    // 前の生成で押された停止を持ち越さない（押した直後に始まった
    // 別の生成が、その場で止まってしまう）
    stopWantedRef.current = false;
    // ⚙パネルを開いたまま送信できるので、生成が始まったら畳んで会話を見せる
    setParamsOpen(false);
    const track = startTracking();
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
            title: (firstUser?.content?.trim() || "新しいチャット").slice(0, MAX_TITLE_LENGTH),
          }),
        });
        if (!res.ok) throw new Error("会話の作成に失敗しました");
        convId = ((await res.json()) as CreateConversationResponse).id;
        convIdRef.current = convId;
        isNew = true;
        // この時点でURLを会話のものに差し替える。ここで navigate すると
        // 画面が作り直されて生成の追従が切れるので、履歴のエントリだけ
        // 書き換える（React Router の state はそのまま持ち越す）。
        // これをしないと、生成が終わる前にリロードした人が新規チャットの
        // 画面に戻されてしまう（会話自体はサーバーに残っているのに）
        window.history.replaceState(window.history.state, "", `/chat/${convId}`);
        // 以後の下書きはこの会話のものとして書く（"new" に溜め続けない）
        adoptDraftScope(convId);
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
          // サーバーツールは tool calling 対応モデルだけ。非対応なら
          // web だけが立ち、サーバー側で :online へ落ちる
          webTools:
            webSearch &&
            !model.startsWith("poe:") &&
            (selectedModel?.supportedParameters.includes("tools") ?? false),
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
            ...contextWindow(history).map(({ role, content, attachments }) => ({
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
          | ErrorResponse
          | null;
        throw new Error(body?.error ?? `エラーが発生しました (${res.status})`);
      }

      const { userMessageId, assistantMessageId } =
        (await res.json()) as GenerateResponse;

      // サーバーが採番したIDをローカル状態へ反映。
      // 貼る相手は「いま置いた生成中のプレースホルダ」に限る。末尾が
      // 別のものに入れ替わっていた場合に、無関係な応答へIDを付けて
      // しまわないための保険（取り直し側でも未保存があれば差し替えない
      // ので、通常の操作でここに掛かることはない）
      setMessages((prev) => {
        const next = [...prev];
        const asst = next[next.length - 1];
        if (asst?.role === "assistant" && asst.status === "streaming" && !asst.id) {
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

      // 返事を待っているあいだに停止を押されていたら、ここで送る
      if (stopWantedRef.current) sendStop(convId, assistantMessageId);

      // 生成過程・最終状態はサーバーを正とし、ポーリングで追いかける
      if (retryConfig) {
        await pollRunUntilDone(convId, track);
      } else {
        await pollUntilDone(convId, assistantMessageId, track);
      }
      // 見届けたので既読に戻す（確定時に未読が立つ）
      markRead(convId);

      if (alive(track)) {
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
          // タイトル生成中にユーザーが自分で遷移していたら（分岐や別会話
          // など）、後追いの自動遷移で引き戻さない。新規会話の最初の応答で
          // 「ここから分岐」した直後に元の会話へ戻されるのはこれが原因。
          // URLは生成開始時に差し替え済みなので、そのままかどうかで見る。
          // ここでの navigate は、React Router 側の現在地（まだ "/"）を
          // 会話ページに合わせ直すためのもの
          if (window.location.pathname === `/chat/${convId}`) {
            await navigate(`/chat/${convId}`, { replace: true });
          }
        } else {
          await refreshPath(convId, track);
          revalidator.revalidate();
        }
      }
    } catch (e) {
      if (alive(track)) {
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
    const parentId = lastSavedId(messages);
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

  /**
   * 押されたのに、止める相手がまだ決まっていない停止。
   *
   * 送信した直後は、応答の行にサーバーのIDがまだ付いていない（保存の
   * 返事を待っている最中）。以前はここで黙って何もしなかったので、
   * **停止ボタンを押しても無反応**に見えた。押した意思を覚えておき、
   * IDが付いた時点で送る。
   */
  const stopWantedRef = useRef(false);

  function sendStop(convId: string, messageId: string) {
    stopWantedRef.current = false;
    void fetch(`/api/conversations/${convId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId }),
    })
      // 失敗はトーストで出す。エラーの帯は取り直しで消えることがあり、
      // 一瞬しか出ないことがある。止め損ねたことは伝わってほしい
      .then((res) => {
        if (!res.ok) showNotice("停止できませんでした");
      })
      .catch(() => showNotice("停止できませんでした"));
  }

  function stop() {
    const convId = convIdRef.current;
    // リトライ生成では末尾が完了済みの応答なので、生成中の行を探す
    const target = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.id && m.status === "streaming");
    if (!convId || !target?.id) {
      // 保存の返事待ち。IDが付いた時点で送る
      stopWantedRef.current = true;
      showNotice("停止しています…");
      return;
    }
    sendStop(convId, target.id);
  }

  /**
   * 応答をぶら下げる親のID。末尾から遡って、実際にサーバーへ保存されて
   * いる直近のメッセージを選ぶ。
   *
   * 送信そのものが失敗すると、楽観表示したユーザー発言はIDを持たないまま
   * 画面に残る。それを親として扱うと親なし（= 新しい根）の応答ができて
   * しまい、会話の木が枝分かれして壊れる。
   */
  function lastSavedId(list: UiMessage[]): string | null {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].id) return list[i].id!;
    }
    return null;
  }

  /**
   * 再生成のときに、末尾のユーザー発言がまだ保存されていなければ
   * 保存し直すための情報を組み立てる。
   */
  function persistFor(history: UiMessage[]): {
    parentId: string | null;
    userContent: string | null;
    userAttachmentIds?: string[];
  } {
    const last = history[history.length - 1];
    if (last?.role === "user" && !last.id) {
      return {
        parentId: lastSavedId(history.slice(0, -1)),
        userContent: last.content,
        userAttachmentIds: last.attachments?.map((a) => a.id),
      };
    }
    return { parentId: lastSavedId(history), userContent: null };
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
    if (!last || last.role !== "user") return;
    void runGeneration([...messages], persistFor([...messages]));
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
    void runGeneration(history, persistFor(history));
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

  /**
   * 選択したものを一括削除する。
   *
   * 選択にはメッセージとコンテキストクリアが混ざりうる。前者は本当に
   * 消えるが、後者は「モデルへ渡す範囲の区切り」が外れるだけで
   * 履歴には何も起きない。文面もそれに合わせて出し分ける。
   */
  async function deleteSelected() {
    const convId = convIdRef.current;
    if (!convId || !selecting || selecting.size === 0) return;
    const picked = [...selecting];
    const boundaryIds = picked
      .filter((id) => id.startsWith(BOUNDARY_SELECT_PREFIX))
      .map((id) => id.slice(BOUNDARY_SELECT_PREFIX.length));
    const messageIds = picked.filter(
      (id) => !id.startsWith(BOUNDARY_SELECT_PREFIX),
    );

    const what = [
      messageIds.length > 0 ? `メッセージ${messageIds.length}件` : null,
      boundaryIds.length > 0 ? `コンテキストクリア${boundaryIds.length}件` : null,
    ]
      .filter(Boolean)
      .join("と");
    if (
      !confirm(
        `${what}を削除します。` +
          (messageIds.length > 0
            ? "メッセージの削除は取り消せません。"
            : "履歴はそのままで、すべてが再びコンテキストになります。") +
          "よろしいですか？",
      )
    ) {
      return;
    }

    try {
      let fresh: UiMessage[] | null = null;
      // 区切りを先に外す。メッセージを消すと区切りは生き残る祖先へ移る
      // 決まりなので、順番が逆だと消したはずの区切りが残ってしまう
      for (const id of boundaryIds) {
        const res = await fetch(`/api/conversations/${convId}/context`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId: id, enabled: false }),
        });
        if (!res.ok) throw new Error();
        fresh = ((await res.json()) as { messages: UiMessage[] }).messages;
      }
      if (messageIds.length > 0) {
        const res = await fetch(`/api/conversations/${convId}/delete-messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: messageIds }),
        });
        if (!res.ok) throw new Error();
        fresh = ((await res.json()) as { messages: UiMessage[] }).messages;
      }
      const keepScroll = captureScroll();
      if (fresh) setMessages(fresh);
      setSelecting(null);
      keepScroll();
      revalidator.revalidate();
    } catch {
      setError("削除に失敗しました。");
      setSelecting(null);
    }
  }

  /**
   * ブランチ切替（ページャ）の世代。
   *
   * 連打すると要求が並んで飛び、返る順は投げた順とは限らない。古いほうが
   * 後に返ると、押したのとは違う枝が最後に表示されて残る。いちばん新しい
   * 要求の結果だけを受け取る。
   */
  const branchSeq = useRef(0);

  /** ブランチ切替（ページャ）。 */
  async function switchBranch(targetId: string) {
    const convId = convIdRef.current;
    if (isStreaming || !convId) return;
    const seq = ++branchSeq.current;
    try {
      const res = await fetch(`/api/conversations/${convId}/path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: targetId }),
      });
      if (!res.ok) throw new Error();
      const { messages: fresh } = (await res.json()) as PathResponse;
      // 追い越されていたら、こちらの結果は捨てる
      if (seq !== branchSeq.current) return;
      setMessages(fresh);
      setError(null);
    } catch {
      if (seq !== branchSeq.current) return;
      setError("ブランチの切替に失敗しました。");
    }
  }

  /**
   * コンテキストの境界線を立てる / 解除する。
   *
   * 履歴は一切消さない。以後の生成でモデルへ送る範囲が狭まるだけで、
   * 解除すれば元どおり全部が文脈に戻る（可逆）。
   */
  async function toggleBoundary(messageId: string, enabled: boolean) {
    const convId = convIdRef.current;
    if (!convId) return;
    // 区切りを足す/外すだけなので、読んでいた位置はそのままにする
    const keepScroll = captureScroll();
    try {
      const res = await fetch(`/api/conversations/${convId}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, enabled }),
      });
      if (!res.ok) throw new Error();
      const { messages: fresh } = (await res.json()) as PathResponse;
      setMessages(fresh);
      setError(null);
      keepScroll();
    } catch {
      setError(
        enabled
          ? "コンテキストクリアを作成できませんでした。"
          : "コンテキストクリアを外せませんでした。",
      );
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
      // 遷移先は履歴が同一で分岐したことに気づきにくい。印を渡して通知を出す
      await navigate(`/chat/${id}`, { state: { forked: true } });
      revalidator.revalidate(); // 分岐先の会話をサイドバーへ反映
    } catch {
      setError("分岐の作成に失敗しました。");
    }
  }

  /**
   * 吹き出しに配る操作一式。
   *
   * Sidebar と同じく毎回作り直す。中の関数は描画のたびに新しくなるので
   * 覚えても同一にはならず、吹き出しは親と一緒に描き直される側だから。
   */
  const messageActions: MessageActions = {
    isStreaming,
    selecting,
    toggleSelect,
    startSelect: (id) => setSelecting(new Set([id])),
    lastIndex: messages.length - 1,
    isImageGeneration,
    usdJpy,
    switchBranch: (id) => void switchBranch(id),
    fork: (id) => void fork(id),
    regenerate: () => regenerate(),
    openImage: setLightbox,
    attachGeneratedImages,
    followBottom,
  };

  // 重ねて出しているものは Escape で閉じる。内側から順に1枚ずつ
  const closeParams = useCallback(() => setParamsOpen(false), []);
  const closePending = useCallback(() => setPendingRun(null), []);
  const cancelSelecting = useCallback(() => setSelecting(null), []);
  useEscapeToClose(selecting != null, cancelSelecting);
  useEscapeToClose(paramsOpen, closeParams);
  useEscapeToClose(pendingRun != null, closePending);
  // 拡大表示（Lightbox）は自前で Escape を見ているので、ここでは足さない

  const lastMessage = messages[messages.length - 1];
  /** 表示中の枝にコンテキストの区切りがあるか（入力欄のアイコンの色）。 */
  const hasContextBoundary = messages.some((m) => m.contextBoundary);

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
        <ModelPicker
          models={models}
          value={model}
          newModelDays={settings.newModelDays}
          onChange={selectModel}
        />
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => setParamsOpen((v) => !v)}
            aria-label="生成パラメータ"
            title="生成パラメータ（この会話にのみ適用）"
            className={`rounded-lg p-2 ${
              Object.keys(params).length > 0
                ? "text-accent-ink hover:bg-accent/10"
                : "text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            }`}
          >
            <IconSliders className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/*
        ⚙のパネル。フッター（コンポーザー）と同じ z-20 だったため、
        画面が低いとパネルの下端がコンポーザーに隠れ、そこのタップも
        奪われていた。あとから開く「上に載せるもの」なので z-30。
      */}
      {paramsOpen && (
        <div className="fixed inset-0 z-30" onClick={() => setParamsOpen(false)}>
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
              <div className="mb-3">
                <RetrySettings
                  value={params}
                  onChange={changeParams}
                  ceiling={settings.retryAttemptCeiling}
                />
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

      {/* 引っぱって更新の印。指の動きに合わせて上のuseEffectが直接動かす */}
      {conversationId && (
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[calc(3rem+env(safe-area-inset-top))] z-10 -translate-x-1/2"
        >
          <div ref={spinnerRef} className="opacity-0">
            <span
              className={`block h-6 w-6 rounded-full border-2 border-neutral-300 border-t-accent dark:border-neutral-700 dark:border-t-accent ${
                refreshing ? "animate-spin" : ""
              }`}
            />
          </div>
        </div>
      )}

      {/*
        画面に出ている進行の印（点滅カーソル・エラーの帯）は見えている
        人にしか届かない。同じことを読み上げへも流す。
      */}
      <LiveRegion isStreaming={isStreaming} error={error} />

      <MessageList
        messages={messages}
        visibleMessages={visibleMessages}
        hiddenCount={hiddenCount}
        actions={messageActions}
        editing={editing}
        setEditing={setEditing}
        onSubmitEdit={() => submitEdit()}
        onAddEditFiles={(files) => void addEditFiles(files)}
        editFileInputRef={editFileInputRef}
        error={error}
        onRegenerate={() => regenerate()}
        onGenerateFromLast={() => generateFromLast()}
        emptyState={emptyState}
        scrollRef={scrollRef}
        feedRef={feedRef}
        onScroll={onScroll}
        footerHeight={footerHeight}
      />

      {/*
        コンポーザー: ChatGPT風の一体型ガラスピル。
        フッター自体は透明グラデーションにし、ピルだけが浮いて見えるようにする。
      */}
      {notice && (
        <div
          className={`pointer-events-none absolute left-1/2 top-[calc(3.75rem+env(safe-area-inset-top))] z-30 max-w-[90%] -translate-x-1/2 truncate rounded-full px-4 py-2 text-sm text-neutral-700 animate-pop dark:text-neutral-200 ${GLASS_PANEL}`}
        >
          {notice}
        </div>
      )}
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
          <SelectionBar
            count={selecting.size}
            hasContextBoundary={hasContextBoundary}
            onCancel={() => setSelecting(null)}
            onDelete={() => void deleteSelected()}
          />
        ) : (
          <Composer
            pending={pending}
            onRemovePending={removePending}
            supportsImages={supportsImages}
            fileInputRef={fileInputRef}
            onPickFiles={(files) => void addFiles(files)}
            onOpenFilePicker={openFilePicker}
            input={input}
            onChangeInput={changeInput}
            onSend={() => send()}
            onPaste={onPaste}
            textareaRef={textareaRef}
            narrow={isNarrow}
            isStreaming={isStreaming}
            onStop={stop}
            canSend={!!input.trim() || readyAttachmentIds.length > 0}
            uploading={uploading}
            canClearContext={
              !!convIdRef.current &&
              !isStreaming &&
              !!lastMessage?.id &&
              lastMessage.contextBoundary !== true
            }
            contextCleared={lastMessage?.contextBoundary === true}
            hasContextBoundary={hasContextBoundary}
            onClearContext={() => {
              if (lastMessage?.id) void toggleBoundary(lastMessage.id, true);
            }}
          />
        )}
      </footer>

      {dragOver && (
        <div className="pointer-events-none absolute inset-3 z-40 grid animate-fade place-items-center rounded-3xl border-2 border-dashed border-accent/60 bg-accent/10 text-sm font-medium text-accent-ink backdrop-blur-sm">
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
