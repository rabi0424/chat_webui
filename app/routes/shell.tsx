import { useCallback, useEffect, useRef, useState } from "react";
import {
  Outlet,
  useNavigation,
  useRevalidator,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type { Route } from "./+types/shell";
import {
  getAppSettings,
  listBots,
  listConversations,
  listFolders,
  type BotRow,
} from "../lib/db.server";
import type { AppSettings } from "../lib/settings";
import { noteConversations } from "../lib/chat-cache";
import { readCachedModels, writeCachedModels } from "../lib/model-cache";
import { fetchJson } from "../lib/fetch-json";
import { loadNotices, type LoadFailures } from "../lib/shell-status";
import { GLASS_PANEL } from "../lib/ui";
import { useEscapeToClose } from "../lib/dismiss";
import { insideScrollableX } from "../lib/swipe";
import type { ModelInfo } from "../lib/openrouter.server";
import type {
  FxResponse,
  ModelsResponse,
  UnreadResponse,
} from "../lib/api-types";
import { Sidebar } from "../components/Sidebar";
import { IconX } from "../components/icons";
import { ConfirmProvider } from "../components/ConfirmDialog";
import { recordNavigation } from "../lib/perf";

/** 未読の印を引き直す間隔（表示中のみ）。 */
const UNREAD_POLL_MS = 5_000;

export interface ShellContext {
  models: ModelInfo[];
  bots: BotRow[];
  /** USD/JPYレート。取得できないときは null（ドル建て表示に戻る）。 */
  usdJpy: number | null;
  /** アプリ全体の設定（設定画面で変更する）。 */
  settings: AppSettings;
  openSidebar: () => void;
}

export async function loader() {
  const started = Date.now();
  // モデル一覧（コールドスタート時は数MBの上流取得）と為替は
  // ここでは待たない。D1だけで最初の画面を出し、モデルは
  // クライアントが /api/models から遅れて読む（Shell内のuseEffect）。
  const [conversations, bots, folders, settings] = await Promise.all([
    listConversations(),
    listBots(),
    listFolders(),
    getAppSettings(),
  ]);
  // 初回表示・コールドスタートの重さを数字で追うための実測
  console.log(`[perf] shell loader ${Date.now() - started}ms`);
  // サイドバーの「今日・昨日」の基準。サーバーとブラウザで同じ値を使う
  // ためにここで決める（描画のたびに時計を読むと、日付の境でハイドレー
  // ションが失敗する）。一覧を取り直すたびに新しくなる
  return { conversations, bots, folders, settings, now: Date.now() };
}

/**
 * ページ遷移ではシェルのローダーを再実行しない。
 *
 * single fetch は既定で親レイアウトのローダーも毎遷移サーバーで走らせる。
 * ここはモデル一覧（コールドスタート時は数MBの取得）・会話一覧・為替と
 * 重く、全ページ遷移の裏でこれを待っていた。サイドバーの鮮度は
 * 各操作後の revalidator.revalidate()（URLが変わらず来る）が担う。
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (currentUrl.pathname !== nextUrl.pathname) return false;
  return defaultShouldRevalidate;
}

/** モデル一覧のローカルキャッシュ。起動直後はこれを即表示し、裏で更新する。 */

/** 起動時間はドキュメント読み込みごとに1回だけ記録する。 */
let startupRecorded = false;

export default function Shell({ loaderData }: Route.ComponentProps) {
  const { conversations, bots, folders, settings, now } = loaderData;
  // 一覧が持っている更新時刻を先読みキャッシュへ伝える。別の端末で
  // 進んだ会話の、古いスナップショットを見せないため
  noteConversations(conversations);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /**
   * モデル一覧と為替。初回表示を待たせないためローダーから外してある。
   * 前回起動時のキャッシュを即座に出し（モデル選択がすぐ使える）、
   * その裏で /api/models を取り直して差し替える。
   */
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [usdJpy, setUsdJpy] = useState<number | null>(null);
  const [failures, setFailures] = useState<LoadFailures>({
    models: null,
    hasCachedModels: false,
    fx: null,
  });
  const [dismissed, setDismissed] = useState(false);

  /**
   * 取り直す。初回の useEffect と、失敗を出したときの「再試行」の
   * 両方から呼ぶ（押しても何も起きない再試行にしないため、状態も戻す）。
   */
  const loadUpstream = useCallback(async () => {
    setDismissed(false);
    // 形が違うものは捨てて読む。使う側は outputModalities.includes(...)
    // のように中の配列を前提にしているので、そのまま渡すと画面が落ちる
    const cached = readCachedModels();
    if (cached.length > 0) setModels(cached);

    const [fresh, fx] = await Promise.all([
      fetchJson<ModelsResponse>("/api/models"),
      fetchJson<FxResponse>("/api/fx"),
    ]);
    if (fresh.ok) {
      setModels(fresh.value.models);
      writeCachedModels(fresh.value.models);
    }
    if (fx.ok) setUsdJpy(fx.value.usdJpy);
    setFailures({
      models: fresh.ok ? null : fresh.reason,
      // 失敗したときに何を出すかは「手元に一覧があるか」で変わる
      hasCachedModels: cached.length > 0,
      fx: fx.ok ? null : fx.reason,
    });
  }, []);

  useEffect(() => {
    void loadUpstream();
  }, [loadUpstream]);

  const notices = dismissed ? [] : loadNotices(failures);

  // 起動（PWAを開く/リロード）の所要時間もパフォーマンス一覧に載せる
  useEffect(() => {
    if (startupRecorded) return;
    startupRecorded = true;
    recordNavigation("(起動)", performance.now());
  }, []);
  /**
   * 未読の会話ID。応答はサーバー側で進むので、別の画面にいるあいだに
   * 完成しても分からない。表示中だけ短い間隔で引き直し、印を最新にする。
   * null = まだ取得していない（ローダーの値をそのまま使う）。
   */
  const [unreadIds, setUnreadIds] = useState<Set<string> | null>(null);
  /**
   * いま生成が走っている会話。サイドバーはこれを見てタイトルを光らせる。
   * 未読と同じ往復で受け取る（印のためにもう1本増やさない）。
   */
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  /**
   * 会話一覧で最後に何かが動いた時刻。ここが変わったら一覧を取り直す。
   *
   * 一覧（並び順・新しい会話・タイトル）はローダーが持っていて、遷移では
   * 取り直さない決まりにしてある（shouldRevalidate。重いローダーを全遷移
   * の裏で待たせないため）。そのため**送信した会話が一番上に上がらない**
   * ——再読込するまで前の並びのまま、という状態になっていた。
   *
   * かといって一覧そのものを数秒おきに引くと、200行の読み出しが延々と
   * 続く（D1 の無料枠は読んだ行数で数える）。動いたかどうかだけを
   * 1つの数字で受け取り、変わったときだけ取り直す。
   */
  const latestRef = useRef<number | null>(null);
  const revalidator = useRevalidator();
  /**
   * 取り直しの手続き。ポーリングの effect は貼り替えたくない（貼り替えると
   * 5秒の間隔がそのたびに仕切り直しになる）ので、最新のものを控えて使う。
   */
  const revalidateRef = useRef(revalidator.revalidate);
  useEffect(() => {
    revalidateRef.current = revalidator.revalidate;
  }, [revalidator.revalidate]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/conversations/unread");
        if (!res.ok) return;
        const { ids, generating, latest } = (await res.json()) as UnreadResponse;
        if (!alive) return;
        setUnreadIds(new Set(ids));
        setGeneratingIds(new Set(generating ?? []));
        // 最初の1回は「いまの値」を控えるだけ（開いた直後に取り直さない）
        const known = latestRef.current;
        if (typeof latest === "number") latestRef.current = latest;
        if (known != null && typeof latest === "number" && latest > known) {
          revalidateRef.current();
        }
      } catch {
        // 印の更新が遅れても実害はない
      }
    };
    void load();
    const timer = setInterval(load, UNREAD_POLL_MS);
    // 別のアプリから戻ってきたときは即座に反映する
    document.addEventListener("visibilitychange", load);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener("focus", load);
    };
  }, []);
  /**
   * ページ遷移の所要時間を記録する（設定画面の「パフォーマンス」で見る）。
   * useNavigation が idle を離れてから戻るまでが「タップ〜画面切り替わり」。
   * 途中で行き先が変わったら（連打など）最後の行き先として記録する。
   */
  const navigation = useNavigation();
  const navTiming = useRef<{ path: string; started: number } | null>(null);
  useEffect(() => {
    if (navigation.state !== "idle" && navigation.location) {
      if (navTiming.current) {
        navTiming.current.path = navigation.location.pathname;
      } else {
        navTiming.current = {
          path: navigation.location.pathname,
          started: performance.now(),
        };
      }
    } else if (navigation.state === "idle" && navTiming.current) {
      const { path, started } = navTiming.current;
      navTiming.current = null;
      recordNavigation(path, performance.now() - started);
    }
  }, [navigation.state, navigation.location]);

  const [sidebarClosing, setSidebarClosing] = useState(false);
  const closeFallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 退場アニメーションを終えてドロワーを外す。 */
  const finishClose = () => {
    if (closeFallback.current) clearTimeout(closeFallback.current);
    closeFallback.current = null;
    setSidebarOpen(false);
    setSidebarClosing(false);
  };

  /**
   * 閉じるときも開くときと同じ滑らかさで（退場アニメーション後にアンマウント）。
   *
   * アンマウントは時間ではなく animationend で決める。会話を選んで閉じる
   * ときは遷移先の描画がすぐ後に走るため、固定時間で外すとアニメーションが
   * 始まる前に消えることがあり、これが「唐突に消えた」正体だった。
   * イベントが来ない場合（アニメーション無効・裏に回ったタブ）の保険として
   * 長めのタイマーも張る。
   */
  const closeSidebar = () => {
    if (sidebarClosing) return;
    setSidebarClosing(true);
    closeFallback.current = setTimeout(finishClose, 700);
  };

  /** 閉じ切る前に開き直されたら、退場を取り消してそのまま出しておく。 */
  const openSidebar = () => {
    if (closeFallback.current) clearTimeout(closeFallback.current);
    closeFallback.current = null;
    setSidebarClosing(false);
    setSidebarOpen(true);
  };

  useEffect(() => {
    return () => {
      if (closeFallback.current) clearTimeout(closeFallback.current);
    };
  }, []);

  // スマホのドロワーも Escape で閉じる（外付けキーボードやiPadで効く）
  const dismissSidebar = useCallback(() => {
    if (!sidebarClosing) closeSidebar();
    // closeSidebar は毎回新しいが、見ているのは ref とフラグだけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarClosing]);
  useEscapeToClose(sidebarOpen && !sidebarClosing, dismissSidebar);

  /**
   * アプリの高さを visualViewport の実測値に同期する。
   * iOS Safari は読み込み直後に 100dvh が実際の表示領域より小さい値の
   * ままになることがあり、入力欄が画面下端より上に浮いて見える
   * （スクロールすると再計算されて直る）。実測値をCSS変数 --app-height で
   * 渡すことで初期表示から正しい高さになり、ツールバーの伸縮や
   * ソフトキーボードの表示にも追従する。
   */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      if (vv.scale !== 1) return; // ピンチズーム中は据え置く
      // ソフトキーボード表示中（入力欄フォーカス中）は更新しない。
      // 縮んだ高さに合わせるとSafari自身の自動パンと二重補正になり、
      // 入力欄が画面上部まで吹き飛ぶ。キーボード中の位置合わせは
      // Safariに任せ、閉じたあとのresizeで追従する。
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "TEXTAREA" || active.tagName === "INPUT")
      ) {
        return;
      }
      // キーボードが残したページのパンを戻す（このアプリのbodyは
      // 本来スクロールしないため、scrollY > 0 はSafariのパンの残骸）
      if (window.scrollY > 0) window.scrollTo(0, 0);
      document.documentElement.style.setProperty(
        "--app-height",
        `${vv.height}px`,
      );
    };
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);

  /**
   * エッジスワイプ: 左端から右へ = ドロワーを開く / 左向き = 閉じる。
   * 縦方向が優勢になった時点でスクロールとみなし判定を打ち切る。
   * 右端は（ブラウザの「進む」ジェスチャと衝突するため）割り当てない。
   */
  const swipeRef = useRef<{ x: number; y: number; fromEdge: boolean } | null>(
    null,
  );
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    // 横に流している最中のコードブロック・表・数式の上から始まった払いは、
    // 中身を戻すためのもの。ドロワーの開閉には使わない
    const scrolling = insideScrollableX(e.target);
    swipeRef.current = {
      x: t.clientX,
      y: t.clientY,
      fromEdge: !scrolling && t.clientX <= 28,
    };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const start = swipeRef.current;
    const t = e.touches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dy) > 16 && Math.abs(dy) > Math.abs(dx)) {
      swipeRef.current = null;
      return;
    }
    if (!sidebarOpen && start.fromEdge && dx > 50) {
      openSidebar();
      swipeRef.current = null;
    } else if (sidebarOpen && !sidebarClosing && dx < -50) {
      closeSidebar();
      swipeRef.current = null;
    }
  };
  const onTouchEnd = () => {
    swipeRef.current = null;
  };

  return (
    <ConfirmProvider>
    <div
      /*
        画面まわり（サイドバー・ボタン・入力欄の案内）は会話の言語に関わらず
        日本語なので、そう宣言しておく。`<html lang>` は開いている会話の言語を
        載せる（Safari の翻訳のため。§3.3）ので、ここで断らないと「英語の
        ページに混じった日本語」を英語だと言い張ることになり、
        ①短い会話では Safari 自身の数えたほうが日本語に振れて翻訳が出ない
        ②翻訳を出せたとき、日本語のままでよいボタン名まで訳される。
        やり取り本文だけは MessageList が会話の言語で上書きする。
      */
      lang="ja"
      className="flex overflow-x-hidden bg-surface text-ink"
      style={{ height: "var(--app-height, 100dvh)" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {/* 本文。見た目は右（order-2）だが、文書の中ではサイドバーより先に置く */}
      <div className="order-2 min-w-0 flex-1">
        <Outlet
          context={
            {
              models,
              bots,
              usdJpy,
              settings,
              openSidebar,
            } satisfies ShellContext
          }
        />
      </div>

      {/*
        デスクトップ: 常設サイドバー（幅はモバイルのドロワーと揃える）。

        **見た目より後ろに置いてある。** 見えている並びは左がサイドバーだが、
        文書の中では本文のほうが先に来るようにし、`order` で見た目だけ左へ
        戻す。ここを文書の先頭に置くと、サーバーが描く会話一覧（20件）の
        日本語のタイトルが**文書の最初の250字を日本語で埋める**（実測で
        先頭100字の81%が日本語）。

        **これは Safari の翻訳が出なかった原因ではない。** 壊れる前
        （8334dd9^）の HTML を取って比べたところ、当時はサイドバーが200件を
        先頭に描いていて先頭100字の81%が日本語——それでも翻訳は出ていた。
        原因は本文の入れ物のほうだった（`PlainMessages`）。

        それでも本文を先にしてあるのは、文書の頭がその文書の主題と一致する
        ほうが素直で、判定の作りしだいでは効きうるから。見た目も操作も
        変わらないので、戻す理由も無い。
      */}
      <div className="order-1 hidden w-72 shrink-0 border-r border-black/[0.06] md:block dark:border-white/[0.06]">
        <Sidebar
          conversations={conversations}
          folders={folders}
          unreadIds={unreadIds}
          generatingIds={generatingIds}
          now={now}
        />
      </div>

      {/* モバイル: ドロワー。高さは fixed inset-0 に任せず、本体と同じ
          --app-height で決める。iOSのスタンドアロン（PWA）では fixed の
          基準がズレることがあり、下部のボタンが浮いて見えていた */}
      {sidebarOpen && (
        <div
          className="fixed inset-x-0 top-0 z-30 md:hidden"
          style={{ height: "var(--app-height, 100dvh)" }}
        >
          <div
            className={`absolute inset-0 bg-black/40 backdrop-blur-sm [will-change:opacity] ${
              sidebarClosing ? "animate-fade-out" : "animate-fade"
            }`}
            onClick={closeSidebar}
          />
          {/* 遷移先の描画と重なってもコマ落ちしないよう、
              変形はあらかじめ合成レイヤに載せておく */}
          <div
            className={`absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl will-change-transform ${
              sidebarClosing ? "animate-drawer-out" : "animate-drawer"
            }`}
            onAnimationEnd={(e) => {
              if (sidebarClosing && e.target === e.currentTarget) finishClose();
            }}
          >
            <Sidebar
              conversations={conversations}
              folders={folders}
              unreadIds={unreadIds}
              generatingIds={generatingIds}
              now={now}
              onNavigate={closeSidebar}
            />
          </div>
        </div>
      )}

      {/*
        裏の取得が失敗したことを出す。黙って戻ると、何が起きたのか
        分からないまま同じ操作を繰り返すことになる（監査 C-2）。
        画面の作りに影響しないよう、重ねて浮かせる。
      */}
      {notices.length > 0 && (
        <div
          role="status"
          className={`fixed left-1/2 top-[calc(0.75rem+env(safe-area-inset-top))] z-50 flex max-w-[min(34rem,92vw)] -translate-x-1/2 items-start gap-3 rounded-2xl px-4 py-2.5 text-sm animate-pop ${GLASS_PANEL}`}
        >
          <div className="min-w-0 flex-1 space-y-1">
            {notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void loadUpstream()}
            className="shrink-0 rounded-lg border border-neutral-300 px-2.5 py-1 text-xs hover:bg-hover dark:border-white/20"
          >
            再試行
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="閉じる"
            className="shrink-0 rounded p-1 text-neutral-500 hover:bg-hover"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
      )}

    </div>
    </ConfirmProvider>
  );
}
