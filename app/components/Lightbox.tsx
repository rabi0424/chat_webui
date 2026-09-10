import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useEscapeToClose } from "../lib/dismiss";
import { IconX } from "./icons";

/**
 * 画像の原寸表示。
 * ダブルタップ（ダブルクリック）でタップ位置を中心に拡大/等倍へ切替、
 * 拡大中はドラッグで移動できる。等倍時のシングルタップ・×・Escで閉じる
 * （シングルタップはダブルタップ猶予の後に確定させる）。
 * 等倍のときは左右に払う（または ← → ）と隣の画像へ移る。払っている
 * あいだは隣の画像が指に付いて現れ、離すとそのまま中央へ滑り込む。
 *
 * 出す画像は URL で受け取る。添付のIDだけを受け取る作りだと、本文の
 * 中の画像（モデルが返した `![](…)`）を開けない——「成功するまで生成」で
 * 積まれた画像はそちらなので、タップしても何も起きなかった。
 */
export function Lightbox({
  src,
  prevSrc,
  nextSrc,
  onPrev,
  onNext,
  footer,
  onClose,
}: {
  /** 表示する画像のURL。 */
  src: string;
  /**
   * 隣の画像のURL。払っているあいだ、指に付いて横から現れる。
   * 渡さなくても払いは効く（隣は見えないまま移る）。
   */
  prevSrc?: string;
  nextSrc?: string;
  /**
   * 隣へ移る。渡されたぶんだけ、その向きへの払いと矢印キーが効く。
   *
   * 端では渡さない（undefined）。すると払っても戻るだけになり、
   * 「これ以上は無い」が指に返る。無い向きへ空振りで移ったように
   * 見せると、閉じたのか進んだのか分からなくなる。
   */
  onPrev?: () => void;
  onNext?: () => void;
  /**
   * 画像の下に敷く帯（説明と操作）。
   *
   * 中の押しどころは、閉じる・拡大の判定へ渡さない（下の div で
   * 止めている）。ここを止め忘れると、ボタンを押した指がそのまま
   * 「等倍でのシングルタップ」と解釈されて閉じてしまう。
   */
  footer?: ReactNode;
  onClose: () => void;
}) {
  const ZOOM = 2.5;
  /** 隣へ移すのに要る払いの距離。これに満たなければ元へ戻す。 */
  const SWIPE_COMMIT_PX = 60;
  /** 払いと縦の動きを見分ける最小の傾き。 */
  const SWIPE_RATIO = 1.2;
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  /** 等倍のときの、指に付いてくる横の移動量（3枚並べた帯ごと動く）。 */
  const [swipeX, setSwipeX] = useState(0);
  const [dragging, setDragging] = useState(false);
  /**
   * 画像が差し替わった直後の1描画だけ、帯をアニメーション無しで置く
   * （下の「継ぎ目」の説明）。次のフレームで 0 へ滑らせる。
   */
  const [jump, setJump] = useState(false);
  /**
   * 差し替わった画像を最初に置く位置。
   *
   * 隣へ移るときの継ぎ目。払いの最中は隣の画像が帯の隣のマスに見えて
   * いる。指を離して親が src を差し替えると、その画像は中央のマスへ
   * 移るので、帯を「隣のマスがあった位置」までずらして置き直せば、
   * 見た目は一切動かない。そこから 0 へ滑らせると、隣の画像が指の
   * 位置から中央へ滑り込む。
   *
   * 以前はここを 0 に戻すだけで、同じ img の src だけ差し替えていた。
   * すると transform が「払った位置 → 0」へ遷移し、左へ払ったのに新しい
   * 画像が左から現れた。
   */
  const pendingJump = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
    隣へ移ったら、拡大と払いを戻す。この入れ物は画像を差し替えても
    作り直されないので、戻さないと次の画像が前の倍率と位置のまま出る。

    描画の中で戻すのは、effect まで待つと**前の倍率のまま一度描かれる**
    ため（拡大した状態で隣へ払うと、次の画像が一瞬拡大して見える）。
    key で作り直す手もあるが、それだと入れ物ごと出直しになり、
    背景のフェードが払うたびに掛かる。
  */
  const [shownSrc, setShownSrc] = useState(src);
  if (shownSrc !== src) {
    setShownSrc(src);
    setT({ scale: 1, x: 0, y: 0 });
    setSwipeX(pendingJump.current ?? 0);
    setJump(pendingJump.current != null);
    pendingJump.current = null;
  }

  /*
   * 置き直した位置を一度ブラウザに確定させてから、次のフレームで 0 へ。
   * 確定させずに 0 にすると、置き直しが描かれないまま遷移が始まらず、
   * 新しい画像がその場に出るだけになる。
   */
  useLayoutEffect(() => {
    if (!jump) return;
    void stripRef.current?.getBoundingClientRect();
    const id = requestAnimationFrame(() => {
      setSwipeX(0);
      setJump(false);
    });
    return () => cancelAnimationFrame(id);
  }, [jump]);

  /** 帯の幅（＝画像1枚ぶんの横の距離）。 */
  const paneWidth = () => containerRef.current?.clientWidth ?? 0;

  /** 隣へ移る。差し替わった画像を、その向きの隣のマスの位置から滑らせる。 */
  const goPrev = () => {
    if (!onPrev) return;
    pendingJump.current = swipeX - paneWidth();
    onPrev();
  };
  const goNext = () => {
    if (!onNext) return;
    pendingJump.current = swipeX + paneWidth();
    onNext();
  };

  /*
   * Escape は共通の重なり順（dismiss の openLayers）へ預ける。
   *
   * 自前で keydown を見ていたころは、その順番に加わっていなかったので
   * 一度の Escape で2枚——拡大表示と、その下のパネル——が同時に閉じて
   * いた（監査 C-7）。矢印だけは拡大表示に固有なので、ここに残す。
   *
   * 渡す関数は固定する。onClose は呼ぶ側で毎回作り直されるので、その
   * まま渡すと描画のたびに重なり順から出入りし、順番が入れ替わる。
   */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const close = useCallback(() => closeRef.current(), []);
  useEscapeToClose(true, close);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 拡大中の矢印は画像を動かすためのものではないので、等倍のときだけ
      if (t.scale !== 1) return;
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 閉じるのを待っている時計（シングルタップの猶予）は、外れるときに畳む
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const clamp = (v: number, limit: number) =>
    Math.max(-limit, Math.min(limit, v));
  /** 画像が画面から離れすぎないよう、移動量をコンテナ基準で制限する。 */
  const limits = (scale: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return {
      x: ((rect?.width ?? 0) * (scale - 1)) / 2,
      y: ((rect?.height ?? 0) * (scale - 1)) / 2,
    };
  };

  /** タップ位置が拡大後も同じ場所に見えるよう平行移動を計算する。 */
  const toggleZoom = (clientX: number, clientY: number) => {
    setT((prev) => {
      if (prev.scale > 1) return { scale: 1, x: 0, y: 0 };
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return prev;
      const dx = clientX - (rect.left + rect.width / 2);
      const dy = clientY - (rect.top + rect.height / 2);
      const lim = limits(ZOOM);
      return {
        scale: ZOOM,
        x: clamp(dx * (1 - ZOOM), lim.x),
        y: clamp(dy * (1 - ZOOM), lim.y),
      };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (drag.current) return; // 2本目以降の指は無視（ピンチは未対応）
    pendingJump.current = null;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: t.x,
      baseY: t.y,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 6) {
      d.moved = true;
      setDragging(true);
    }
    if (d.moved && t.scale === 1 && Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO) {
      // 行き先が無い向きは重くする（動かないと壊れて見え、そのまま
      // 動くと「進めた」と誤解される）
      const blocked = dx > 0 ? !onPrev : !onNext;
      setSwipeX(blocked ? dx * 0.25 : dx);
    }
    if (d.moved && t.scale > 1) {
      const lim = limits(t.scale);
      setT((prev) => ({
        ...prev,
        x: clamp(d.baseX + dx, lim.x),
        y: clamp(d.baseY + dy, lim.y),
      }));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (d.moved) {
      // 払い切っていれば隣へ。足りなければ戻すだけ（どちらも指を離した
      // 時点で swipeX は 0 に戻す——隣へ移れば新しい画像が中央に出る）
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (
        t.scale === 1 &&
        Math.abs(dx) >= SWIPE_COMMIT_PX &&
        Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO &&
        (dx > 0 ? onPrev : onNext)
      ) {
        // 隣へ。src が差し替わる描画で帯が置き直され、そこから滑る
        if (dx > 0) goPrev();
        else goNext();
      } else {
        setSwipeX(0);
      }
      return; // ドラッグはタップとして扱わない
    }

    const now = Date.now();
    const last = lastTap.current;
    lastTap.current = { time: now, x: e.clientX, y: e.clientY };
    if (
      last &&
      now - last.time < 300 &&
      Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40
    ) {
      lastTap.current = null;
      toggleZoom(e.clientX, e.clientY);
      return;
    }
    if (t.scale === 1) {
      closeTimer.current = setTimeout(onClose, 280);
    }
  };

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 animate-fade touch-none select-none overflow-hidden bg-black/80 backdrop-blur-sm"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
        setSwipeX(0);
      }}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
    >
      {/*
        3枚を横に並べた帯。中央がいまの画像、左右のマスに隣の画像。
        払うと帯ごと動くので、隣の画像が指に付いて現れる。拡大中は
        隣を消す（拡大した画像が隣のマスまで広がって重なる）。
      */}
      <div
        ref={stripRef}
        className="absolute inset-0"
        style={{
          transform: `translateX(${swipeX}px)`,
          transition: dragging || jump ? "none" : "transform 0.2s ease-out",
        }}
      >
        {prevSrc && t.scale === 1 && (
          <div
            aria-hidden
            className="absolute inset-y-0 right-full flex w-full items-center justify-center p-4"
          >
            <img
              src={prevSrc}
              alt=""
              draggable={false}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <img
            src={src}
            alt="添付画像"
            draggable={false}
            style={{
              transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
              transition: dragging ? "none" : "transform 0.2s ease-out",
            }}
            className={`max-h-full max-w-full object-contain ${
              t.scale > 1 ? "cursor-grab" : ""
            }`}
          />
        </div>
        {nextSrc && t.scale === 1 && (
          <div
            aria-hidden
            className="absolute inset-y-0 left-full flex w-full items-center justify-center p-4"
          >
            <img
              src={nextSrc}
              alt=""
              draggable={false}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}
      </div>
      {footer && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-8 text-white"
        >
          {footer}
        </div>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="閉じる"
        className="absolute right-3 top-[calc(0.75rem+env(safe-area-inset-top))] grid h-9 w-9 place-items-center rounded-full bg-black/50 text-white backdrop-blur hover:bg-black/70"
      >
        <IconX className="h-5 w-5" />
      </button>
    </div>
  );
}
