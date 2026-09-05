import { useCallback, useEffect, useRef, useState } from "react";
import {
  PULL_IGNORE_SELECTOR,
  PULL_MAX_PX,
  PULL_REST_PX,
  PULL_SLOP_PX,
  PULL_TRIGGER_PX,
} from "../lib/pull-to-refresh";
import { Link, useNavigate, useOutletContext } from "react-router";
import type { Route } from "./+types/images";
import type { ShellContext } from "./shell";
import { listGeneratedImages, type GeneratedImageRow } from "../lib/db.server";
import { Lightbox } from "../components/Lightbox";
import type { ImagesResponse } from "../lib/api-types";
import { invalidateChat } from "../lib/chat-cache";
import {
  IconEllipsis,
  IconMenu,
  IconPencilSquare,
  IconPhoto,
  IconSearch,
  IconX,
} from "../components/icons";
import { EMPTY_ACTION, EmptyState } from "../components/EmptyState";
import { TERSE_INPUT } from "../lib/ui";
import { MENU_ITEM, MenuPanel } from "../components/sidebar/items";
import { IMAGES_PAGE_SIZE } from "../lib/constants";
import { useEscapeToClose } from "../lib/dismiss";

export function meta() {
  return [{ title: "画像 - Chat" }];
}

/**
 * 一度に読む枚数。続きは末尾まで送ると自動で足す。
 * 値は lib/constants.ts に置く（続き読みのAPIと同じものを使うため）。
 */
const PAGE_SIZE = IMAGES_PAGE_SIZE;
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

/**
 * 一覧の1マス。
 *
 * 「…」の中身はマスの中に置かない。マスには画面外を飛ばす指定
 * （content-visibility）が付いており、これは paint containment を
 * 伴う——**はみ出したぶんが描かれずに消える**。マスはスマホで画面の
 * 1/3、デスクトップでは1/6の幅しかないので、メニュー（176px）は必ず
 * はみ出す。「…」に右を揃えているぶん食み出すのは左側で、文字の頭が
 * 切り落とされた読めない板になっていた。器の外（body 直下）へ出し、
 * ボタンの位置に合わせて置く。
 *
 * ここを関数の内側ではなく外に置くのは、描画のたびに別のコンポーネント
 * として扱われてマスの DOM が作り直されるのを避けるため（数百枚並ぶ）。
 */
function ImageTile({
  img,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  onView,
  onToggleFavorite,
  onOpenConversation,
}: {
  img: GeneratedImageRow;
  menuOpen: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onView: () => void;
  onToggleFavorite: () => void;
  onOpenConversation: () => void;
}) {
  /* メニューを置く基準。ポータルで body 直下に描くので、位置はここから測る */
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  return (
    /*
      画面の外に出たマスは中身の組み立てを飛ばす
      （content-visibility）。スクロールで足していく一覧なので
      枚数は数百に達し、画面外のぶんも毎回レイアウトと描画の
      対象になっていた。

      そのために **マスの大きさをマスの側で決める**。
      content-visibility が効いている間、中身は大きさの
      計算から外れる（size containment）ので、高さを中の
      画像から取っていると畳まれた瞬間に潰れる。正方形は
      ここで宣言し、画像はその中いっぱいに敷く。
    */
    <div className="group/img relative aspect-square [content-visibility:auto]">
      <button
        type="button"
        onClick={onView}
        title={img.prompt ?? undefined}
        className="block h-full w-full overflow-hidden bg-sunken"
      >
        <img
          src={`/api/files/${img.id}`}
          alt={img.prompt ?? "生成画像"}
          loading="lazy"
          // 復号を本筋から外す。原寸を並べるので1枚が重い
          decoding="async"
          className="h-full w-full object-cover transition-opacity group-hover/img:opacity-90"
        />
      </button>

      {img.favorite === 1 && (
        <span
          aria-label="お気に入り"
          className="pointer-events-none absolute left-1 top-1 rounded-full bg-black/45 px-1.5 py-0.5 text-xs text-white"
        >
          ★
        </span>
      )}

      <button
        ref={menuButtonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (menuOpen) onCloseMenu();
          else onOpenMenu();
        }}
        aria-label="この画像の操作"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        /*
          開いているあいだは出したままにする。メニューはマスの外
          （ポータル）に居るので、そちらへポインタを移すとマスの
          ホバーが外れ、押したボタンだけが消える
        */
        className={`absolute right-1 top-1 rounded-lg bg-black/45 p-1 text-white focus:opacity-100 touch:opacity-100 ${
          menuOpen ? "opacity-100" : "opacity-0 group-hover/img:opacity-100"
        }`}
      >
        <IconEllipsis className="h-4 w-4" />
      </button>

      {menuOpen && (
        <MenuPanel
          title={img.prompt ?? "画像"}
          onClose={onCloseMenu}
          anchorRef={menuButtonRef}
        >
          <button
            type="button"
            role="menuitem"
            onClick={onToggleFavorite}
            className={MENU_ITEM}
          >
            {img.favorite === 1 ? "お気に入りを解除" : "お気に入りに追加"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!img.conversation_id}
            onClick={onOpenConversation}
            className={`${MENU_ITEM} disabled:opacity-40`}
          >
            会話を開く
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCloseMenu();
              onView();
            }}
            className={MENU_ITEM}
          >
            原寸で表示
          </button>
        </MenuPanel>
      )}
    </div>
  );
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
  const closeMenu = useCallback(() => setMenu(null), []);
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
  /** 更新中か。表示は直接DOMへ書くので、状態は ref だけで足りる。 */
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
      const body = (await res.json()) as ImagesResponse;
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
    // 待っている途中で外れたら引き直さない。閉じた画面のための問い合わせで
    // Workers のサブリクエストを使ってしまう（監査 C-9）
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
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
      paint(PULL_REST_PX, true);
      void reloadRef.current().finally(() => {
        refreshingRef.current = false;
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
      const body = (await res.json()) as ImagesResponse;
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

  /**
   * その画像を作った枝を開く。
   *
   * 会話を開くだけでは、**最後に見ていた枝**が出る。何度も作り直した
   * 会話では、いま見ている画像とは違う結果（別の依頼文で作った枝）が
   * 開くことになり、どれがこの画像の元なのか辿れない。開く前に、
   * その画像を返した応答の枝へ表示を移しておく。
   *
   * 先読みキャッシュも捨てる。枝の切り替えは会話の updated_at を
   * 動かさないので、鮮度の突き合わせでは古いと判定されない——
   * 捨てずに開くと、切り替える前のスナップショットがそのまま出る。
   */
  async function openConversation(img: GeneratedImageRow) {
    const convId = img.conversation_id;
    if (!convId) return;
    if (img.message_id) {
      try {
        const res = await fetch(`/api/conversations/${convId}/path`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId: img.message_id }),
        });
        // 切り替えられなかったときは、そのまま（最後に見ていた枝で）開く。
        // 開けないより、違う枝でも会話に着いたほうがましなため
        if (res.ok) invalidateChat(convId);
      } catch {
        // 通信が落ちていても会話は開く
      }
    }
    navigate(`/chat/${convId}`);
  }

  useEscapeToClose(menu != null, closeMenu);

  /**
   * 拡大表示中の1枚。IDではなく行を引き直すのは、開いたまま
   * お気に入りを切り替えたときに帯の★もその場で変わるようにするため。
   * 一覧から消えた（検索が変わった）ときは null になり、拡大表示も閉じる。
   */
  const current = lightbox ? images.find((x) => x.id === lightbox) : undefined;
  const currentIndex = current ? images.indexOf(current) : -1;

  /**
   * 拡大表示のまま隣の画像へ移る。
   *
   * 端の手前まで来たら、裏で続きを読み始める（払い続けているあいだに
   * 途切れないように）。読み終わるまでは行き先が無いので onNext を
   * 渡さない側に倒れるが、次の払いには間に合う。
   */
  const NEAR_END = 5;
  const goTo = (delta: number) => {
    const next = images[currentIndex + delta];
    if (!next) return;
    setLightbox(next.id);
    if (!exhausted && currentIndex + delta >= images.length - NEAR_END) {
      loadMoreRef.current();
    }
  };

  return (
    <div
      className="flex h-full flex-col"
      onClick={() => menu && setMenu(null)}
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-line px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="メニュー"
          className="rounded-lg p-2 text-ink-2 hover:bg-hover md:hidden"
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
              : "text-ink-2 hover:bg-hover"
          }`}
        >
          ★ お気に入り
        </button>
      </header>

      <div className="shrink-0 border-b border-line p-3">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="依頼文・モデル名・会話名で検索"
            aria-label="画像を検索"
            {...TERSE_INPUT}
            className="w-full rounded-xl border border-neutral-200 bg-neutral-50 py-2 pl-8 pr-8 text-base outline-none placeholder:text-neutral-400 focus:border-accent/60 sm:text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="検索をクリア"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-400 hover:bg-hover"
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
          className="flex items-end justify-center overflow-hidden text-xs text-ink-3"
        >
          <span
            ref={pullLabelRef}
            style={{ opacity: 0 }}
            className="pb-2 transition-opacity duration-150"
          />
        </div>
        {images.length === 0 ? (
          <div className="mt-16">
            {loading ? (
              <p className="text-center text-sm text-ink-3">読み込み中…</p>
            ) : query || favoritesOnly ? (
              <EmptyState
                icon={<IconPhoto />}
                title="該当する画像がありません"
                description="絞り込みを外すか、別の語で探してください。"
              />
            ) : (
              <EmptyState
                icon={<IconPhoto />}
                title="生成された画像がここに並びます"
                description="画像を作れるモデルで話すと、返ってきた画像が新しい順に集まります。"
                action={
                  <Link to="/" className={EMPTY_ACTION}>
                    <IconPencilSquare className="h-4 w-4" />
                    画像を作れるモデルで話す
                  </Link>
                }
              />
            )}
          </div>
        ) : (
          <>
            {/*
              隙間を詰めたタイル。1枚ごとに依頼文と日付を添えると、
              画像より説明のほうが場所を取り、並べたときに絵として
              見渡せない。説明と操作は開いたとき（Lightbox）に出す。
            */}
            <div className="grid grid-cols-3 gap-0.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {images.map((img) => (
                <ImageTile
                  key={img.id}
                  img={img}
                  menuOpen={menu === img.id}
                  onOpenMenu={() => setMenu(img.id)}
                  onCloseMenu={closeMenu}
                  onView={() => setLightbox(img.id)}
                  onToggleFavorite={() => void toggleFavorite(img)}
                  onOpenConversation={() => void openConversation(img)}
                />
              ))}
            </div>
            <div
              ref={sentinelRef}
              className="mt-4 flex justify-center py-2 text-xs text-ink-3"
            >
              {exhausted ? (
                images.length > PAGE_SIZE && "これで全部です"
              ) : loading ? (
                "読み込み中…"
              ) : (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  className="rounded-lg px-3 py-1 hover:bg-hover"
                >
                  もっと見る
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {current && (
        <Lightbox
          src={`/api/files/${current.id}`}
          onClose={() => setLightbox(null)}
          /*
            端では渡さない。渡さないほうへ払うと戻るだけになるので、
            「これ以上は無い」が指に返る
          */
          onPrev={currentIndex > 0 ? () => goTo(-1) : undefined}
          onNext={
            currentIndex >= 0 && currentIndex < images.length - 1
              ? () => goTo(1)
              : undefined
          }
          /*
            開いたまま何もできないと、会話へ戻るのに一度閉じて一覧の
            「…」を開き直すことになる。説明と操作はここに置く。
          */
          footer={
            <div className="mx-auto flex max-w-3xl items-end gap-3">
              <div className="min-w-0 flex-1">
                {current.prompt && (
                  <p className="line-clamp-3 text-sm leading-relaxed">
                    {current.prompt}
                  </p>
                )}
                <p className="mt-1 truncate text-xs text-white/70">
                  <span suppressHydrationWarning>
                    {formatDate(current.created_at)}
                  </span>
                  {current.model_id && ` · ${modelName(current.model_id)}`}
                  {current.title && ` · ${current.title}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void toggleFavorite(current)}
                  aria-pressed={current.favorite === 1}
                  aria-label={
                    current.favorite === 1
                      ? "お気に入りを解除"
                      : "お気に入りに追加"
                  }
                  className={`grid h-9 w-9 place-items-center rounded-full backdrop-blur ${
                    current.favorite === 1
                      ? "bg-white text-black"
                      : "bg-black/50 text-white hover:bg-black/70"
                  }`}
                >
                  ★
                </button>
                {current.conversation_id && (
                  <button
                    type="button"
                    onClick={() => void openConversation(current)}
                    className="rounded-full bg-white/90 px-3.5 py-2 text-xs font-medium text-black hover:bg-white"
                  >
                    会話を開く
                  </button>
                )}
              </div>
            </div>
          }
        />
      )}
    </div>
  );
}


// 例外の受け皿はこのルートに置く。root に任せると文書ごと
// 差し替わり、サイドバーまで消えて戻る導線が無くなる
export { RouteError as ErrorBoundary } from "../components/RouteError";
