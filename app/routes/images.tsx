import { useEffect, useRef, useState } from "react";
import {
  PULL_IGNORE_SELECTOR,
  PULL_MAX_PX,
  PULL_REST_PX,
  PULL_SLOP_PX,
  PULL_TRIGGER_PX,
} from "../lib/pull-to-refresh";
import { useNavigate, useOutletContext } from "react-router";
import type { Route } from "./+types/images";
import type { ShellContext } from "./shell";
import { listGeneratedImages, type GeneratedImageRow } from "../lib/db.server";
import { Lightbox } from "../components/Lightbox";
import { IconEllipsis, IconMenu, IconSearch, IconX } from "../components/icons";
import { GLASS_PANEL } from "../lib/ui";

export function meta({}: Route.MetaArgs) {
  return [{ title: "画像 - Chat WebUI" }];
}

/** 一度に読む枚数。続きは末尾まで送ると自動で足す。 */
const PAGE_SIZE = 60;
/* 引っぱって更新の寸法は lib/pull-to-refresh.ts に集約（会話画面と共通） */

export async function loader() {
  return { images: await listGeneratedImages({ limit: PAGE_SIZE }) };
}

/**
 * 日付。サーバー（Workers = UTC）とブラウザ（端末のタイムゾーン）では
 * 日付がずれることがあるので、出す側で suppressHydrationWarning を付けて
 * ブラウザ側の値を正とする。付けないとハイドレーションのやり直しになり、
 * <html> に載せたテーマなどが巻き添えで消える（lib/appearance.ts 参照）。
 */
function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** モデルIDは長いので、末尾の名前だけ出す。 */
function modelName(id: string | null): string {
  if (!id) return "";
  return id.replace(/^poe:/, "").split("/").pop() ?? id;
}

export default function Images({ loaderData }: Route.ComponentProps) {
  const { openSidebar } = useOutletContext<ShellContext>();
  const navigate = useNavigate();
  const [images, setImages] = useState<GeneratedImageRow[]>(loaderData.images);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(
    loaderData.images.length < PAGE_SIZE,
  );
  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  /** 「…」を開いている画像ID。 */
  const [menu, setMenu] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 一覧の末尾。ここが見えたら続きを読む。 */
  const sentinelRef = useRef<HTMLDivElement>(null);
  /** 監視のコールバックから最新の状態を読むための控え。 */
  const loadMoreRef = useRef<() => void>(() => {});
  /** 二重読み込みの保険（状態の反映を待たずに弾く）。 */
  const loadingRef = useRef(false);
  /** スクロール領域。引っぱって更新の判定に使う。 */
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * 引っぱりの余白。指に追従する部分は state を通さず直接DOMへ書く。
   * touchmove ごとに再描画すると、画像が数十枚並んだグリッドを毎フレーム
   * 作り直すことになり、指の動きから遅れる。
   */
  const pullRef = useRef(0);
  const spacerRef = useRef<HTMLDivElement>(null);
  const pullLabelRef = useRef<HTMLSpanElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  /** 検索・絞り込みの初回描画では読み直さない（ローダーの結果を使う）。 */
  const firstRender = useRef(true);

  const params = (before?: number) => {
    const p = new URLSearchParams();
    if (before) p.set("before", String(before));
    if (query.trim()) p.set("q", query.trim());
    if (favoritesOnly) p.set("favorites", "1");
    return p.toString();
  };

  /** 先頭のページを取り直す（検索・絞り込みの変更と、引っぱって更新）。 */
  async function reload() {
    try {
      const res = await fetch(`/api/images?${params()}`);
      const body = (await res.json()) as { images: GeneratedImageRow[] };
      setImages(body.images);
      setExhausted(body.images.length < PAGE_SIZE);
    } catch {
      // 失敗しても既に出ている分はそのまま
    }
  }
  reloadRef.current = reload;

  // 検索語・絞り込みの変更で引き直す（入力はデバウンス）
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setLoading(true);
    searchTimer.current = setTimeout(async () => {
      await reloadRef.current();
      setLoading(false);
    }, 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, favoritesOnly]);

  /**
   * 一番上で下へ引っぱると一覧を取り直す（SNSのフィードと同じ操作）。
   *
   * タッチは素の listener で拾う。引っぱっている間は端末側のバウンスを
   * 止める必要があり、Reactのハンドラでは preventDefault が効かないため。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let startY = 0;
    let active = false;
    // 遊びを超えて初めて「引っぱり」に切り替える（それまではタップ扱い）
    let engaged = false;

    const paint = (distance: number, animated: boolean) => {
      pullRef.current = distance;
      const spacer = spacerRef.current;
      if (spacer) {
        spacer.style.transition = animated ? "height 0.2s ease-out" : "none";
        spacer.style.height = `${distance}px`;
      }
      const label = pullLabelRef.current;
      if (label) {
        label.style.opacity = distance > 0 ? "1" : "0";
        label.textContent = refreshingRef.current
          ? "更新中…"
          : distance >= PULL_TRIGGER_PX
            ? "離して更新"
            : "引っぱって更新";
      }
    };

    const onStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement | null;
      active =
        el.scrollTop <= 0 &&
        e.touches.length === 1 &&
        !refreshingRef.current &&
        // ボタンや画像の上から始まった指は、最初から引っぱりに使わない
        !target?.closest(PULL_IGNORE_SELECTOR);
      startY = e.touches[0]?.clientY ?? 0;
      engaged = false;
    };
    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const dy = (e.touches[0]?.clientY ?? 0) - startY;
      if (dy <= 0 || el.scrollTop > 0) {
        // 上向き・途中からのスクロールは通常のスクロールに任せる
        if (pullRef.current > 0) paint(0, true);
        active = false;
        engaged = false;
        return;
      }
      // 遊びの内側はまだ何もしない。ここで preventDefault すると
      // 指がわずかにぶれただけのタップが click を失う
      if (!engaged) {
        if (dy < PULL_SLOP_PX) return;
        engaged = true;
      }
      // 引くほど重くする（遊びぶんを差し引いた移動の半分、上限まで）
      paint(Math.min(PULL_MAX_PX, (dy - PULL_SLOP_PX) * 0.5), false);
      if (e.cancelable) e.preventDefault();
    };
    const onEnd = () => {
      if (!active) return;
      active = false;
      engaged = false;
      const triggered = pullRef.current >= PULL_TRIGGER_PX;
      if (!triggered) {
        paint(0, true);
        return;
      }
      refreshingRef.current = true;
      setRefreshing(true);
      paint(PULL_REST_PX, true);
      void reloadRef.current().finally(() => {
        refreshingRef.current = false;
        setRefreshing(false);
        paint(0, true);
      });
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
  }, []);

  /**
   * 末尾が見えたら続きを読む（下スクロールでの自動読み込み）。
   * 監視は貼り替えず、実処理は ref 経由で最新のものを呼ぶ。
   */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      // 少し手前から読み始めて、待ち時間を感じさせない
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [images.length === 0]);

  async function loadMore() {
    const last = images[images.length - 1];
    if (!last || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/api/images?${params(last.created_at)}`);
      const body = (await res.json()) as { images: GeneratedImageRow[] };
      setImages([...images, ...body.images]);
      if (body.images.length < PAGE_SIZE) setExhausted(true);
    } catch {
      // 失敗しても既に出ている分はそのまま
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  loadMoreRef.current = () => {
    if (!exhausted) void loadMore();
  };

  async function toggleFavorite(img: GeneratedImageRow) {
    const favorite = img.favorite !== 1;
    setImages((prev) =>
      prev.map((x) =>
        x.id === img.id ? { ...x, favorite: favorite ? 1 : 0 } : x,
      ),
    );
    setMenu(null);
    try {
      await fetch(`/api/images/${img.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite }),
      });
    } catch {
      // 失敗したら元に戻す
      setImages((prev) =>
        prev.map((x) =>
          x.id === img.id ? { ...x, favorite: favorite ? 0 : 1 } : x,
        ),
      );
    }
  }

  return (
    <div
      className="flex h-full flex-col"
      onClick={() => menu && setMenu(null)}
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-neutral-100 px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] dark:border-neutral-800">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="メニュー"
          className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 md:hidden dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <IconMenu className="h-5 w-5" />
        </button>
        <h1 className="px-1 text-sm font-semibold tracking-tight">画像</h1>
        <button
          type="button"
          onClick={() => setFavoritesOnly((v) => !v)}
          aria-pressed={favoritesOnly}
          title="お気に入りだけ表示"
          className={`ml-auto rounded-lg px-2.5 py-1.5 text-xs font-medium ${
            favoritesOnly
              ? "bg-accent/10 text-accent-ink"
              : "text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          }`}
        >
          ★ お気に入り
        </button>
      </header>

      <div className="shrink-0 border-b border-neutral-100 p-3 dark:border-neutral-800">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="依頼文・モデル名・会話名で検索"
            aria-label="画像を検索"
            className="w-full rounded-xl border border-neutral-200 bg-neutral-50 py-2 pl-8 pr-8 text-base outline-none placeholder:text-neutral-400 focus:border-accent/60 sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="検索をクリア"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <IconX className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3"
      >
        {/*
          引っぱって更新の余白。高さと文言は touchmove ごとに直接書き換える
          （state を通すと一覧全体が毎フレーム作り直しになる）。
        */}
        <div
          ref={spacerRef}
          style={{ height: 0 }}
          className="flex items-end justify-center overflow-hidden text-xs text-neutral-400 dark:text-neutral-500"
        >
          <span
            ref={pullLabelRef}
            style={{ opacity: 0 }}
            className="pb-2 transition-opacity duration-150"
          />
        </div>
        {images.length === 0 ? (
          <p className="mt-16 text-center text-sm text-neutral-400 dark:text-neutral-500">
            {loading
              ? "読み込み中…"
              : query || favoritesOnly
                ? "該当する画像がありません"
                : "生成された画像がここに並びます"}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {images.map((img) => (
                <div key={img.id} className="group/img relative">
                  <button
                    type="button"
                    onClick={() => setLightbox(img.id)}
                    className="block w-full overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900"
                  >
                    <img
                      src={`/api/files/${img.id}`}
                      alt={img.prompt ?? "生成画像"}
                      loading="lazy"
                      className="aspect-square w-full object-cover transition-transform group-hover/img:scale-[1.02]"
                    />
                  </button>

                  {img.favorite === 1 && (
                    <span
                      aria-label="お気に入り"
                      className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/45 px-1.5 py-0.5 text-xs text-white"
                    >
                      ★
                    </span>
                  )}

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenu(menu === img.id ? null : img.id);
                    }}
                    aria-label="この画像の操作"
                    className="absolute right-1.5 top-1.5 rounded-lg bg-black/45 p-1 text-white opacity-0 group-hover/img:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <IconEllipsis className="h-4 w-4" />
                  </button>

                  {menu === img.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className={`absolute right-1.5 top-9 z-10 w-44 rounded-xl p-1 animate-pop ${GLASS_PANEL}`}
                    >
                      <button
                        type="button"
                        onClick={() => void toggleFavorite(img)}
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-white/10"
                      >
                        {img.favorite === 1
                          ? "お気に入りを解除"
                          : "お気に入りに追加"}
                      </button>
                      <button
                        type="button"
                        disabled={!img.conversation_id}
                        onClick={() => navigate(`/chat/${img.conversation_id}`)}
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-200 dark:hover:bg-white/10"
                      >
                        会話を開く
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMenu(null);
                          setLightbox(img.id);
                        }}
                        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-white/10"
                      >
                        原寸で表示
                      </button>
                    </div>
                  )}

                  <div className="mt-1 px-0.5">
                    {img.prompt && (
                      <p
                        className="truncate text-xs text-neutral-500 dark:text-neutral-400"
                        title={img.prompt}
                      >
                        {img.prompt}
                      </p>
                    )}
                    <p className="truncate text-[11px] text-neutral-400 dark:text-neutral-500">
                      <span suppressHydrationWarning>
                        {formatDate(img.created_at)}
                      </span>
                      {img.model_id && ` · ${modelName(img.model_id)}`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <div
              ref={sentinelRef}
              className="mt-4 flex justify-center py-2 text-xs text-neutral-400 dark:text-neutral-500"
            >
              {exhausted ? (
                images.length > PAGE_SIZE && "これで全部です"
              ) : loading ? (
                "読み込み中…"
              ) : (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  className="rounded-lg px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  もっと見る
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {lightbox && (
        <Lightbox id={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
