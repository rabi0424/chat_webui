import { useEffect, useRef, useState } from "react";
import { Outlet, useNavigation } from "react-router";
import type { Route } from "./+types/shell";
import {
  getAppSettings,
  listBots,
  listConversations,
  listFolders,
  type BotRow,
  type FolderRow,
} from "../lib/db.server";
import type { AppSettings } from "../lib/settings";
import { fetchModels, type ModelInfo } from "../lib/openrouter.server";
import { fetchUsdJpy } from "../lib/fx.server";
import { Sidebar } from "../components/Sidebar";
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
  const [models, conversations, bots, folders, usdJpy, settings] =
    await Promise.all([
      fetchModels(),
      listConversations(),
      listBots(),
      listFolders(),
      fetchUsdJpy(),
      getAppSettings(),
    ]);
  // 初回表示・コールドスタートの重さを数字で追うための実測
  console.log(`[perf] shell loader ${Date.now() - started}ms`);
  return { models, conversations, bots, folders, usdJpy, settings };
}

export default function Shell({ loaderData }: Route.ComponentProps) {
  const { models, conversations, bots, folders, usdJpy, settings } = loaderData;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /**
   * 未読の会話ID。応答はサーバー側で進むので、別の画面にいるあいだに
   * 完成しても分からない。表示中だけ短い間隔で引き直し、印を最新にする。
   * null = まだ取得していない（ローダーの値をそのまま使う）。
   */
  const [unreadIds, setUnreadIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/conversations/unread");
        if (!res.ok) return;
        const { ids } = (await res.json()) as { ids: string[] };
        if (alive) setUnreadIds(new Set(ids));
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

  /** 閉じるときも開くときと同じ滑らかさで（退場アニメーション後にアンマウント）。 */
  const closeSidebar = () => {
    if (sidebarClosing) return;
    setSidebarClosing(true);
    setTimeout(() => {
      setSidebarOpen(false);
      setSidebarClosing(false);
    }, 220);
  };

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
    swipeRef.current = { x: t.clientX, y: t.clientY, fromEdge: t.clientX <= 28 };
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
      setSidebarOpen(true);
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
    <div
      className="flex overflow-x-hidden bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
      style={{ height: "var(--app-height, 100dvh)" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {/* デスクトップ: 常設サイドバー（幅はモバイルのドロワーと揃える） */}
      <div className="hidden w-72 shrink-0 border-r border-neutral-100 md:block dark:border-neutral-800">
        <Sidebar
          conversations={conversations}
          folders={folders}
          unreadIds={unreadIds}
        />
      </div>

      {/* モバイル: ドロワー */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 md:hidden">
          <div
            className={`absolute inset-0 bg-black/40 backdrop-blur-sm ${
              sidebarClosing ? "animate-fade-out" : "animate-fade"
            }`}
            onClick={closeSidebar}
          />
          <div
            className={`absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl dark:bg-neutral-950 ${
              sidebarClosing ? "animate-drawer-out" : "animate-drawer"
            }`}
          >
            <Sidebar
              conversations={conversations}
              folders={folders}
              unreadIds={unreadIds}
              onNavigate={closeSidebar}
            />
          </div>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <Outlet
          context={
            {
              models,
              bots,
              usdJpy,
              settings,
              openSidebar: () => setSidebarOpen(true),
            } satisfies ShellContext
          }
        />
      </div>
    </div>
  );
}
