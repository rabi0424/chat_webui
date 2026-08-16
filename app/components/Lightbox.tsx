import { useEffect, useRef, useState } from "react";
import { IconX } from "./icons";

/**
 * 画像の原寸表示。
 * ダブルタップ（ダブルクリック）でタップ位置を中心に拡大/等倍へ切替、
 * 拡大中はドラッグで移動できる。等倍時のシングルタップ・×・Escで閉じる
 * （シングルタップはダブルタップ猶予の後に確定させる）。
 */
export function Lightbox({ id, onClose }: { id: string; onClose: () => void }) {
  const ZOOM = 2.5;
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [onClose]);

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
      if (t.scale > 1) setDragging(true);
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
    if (d.moved) return; // ドラッグはタップとして扱わない

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
      className="fixed inset-0 z-50 flex animate-fade touch-none select-none items-center justify-center overflow-hidden bg-black/80 p-4 backdrop-blur-sm"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
    >
      <img
        src={`/api/files/${id}`}
        alt="添付画像"
        draggable={false}
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          transition: dragging ? "none" : "transform 0.2s ease-out",
        }}
        className={`max-h-full max-w-full rounded-xl object-contain ${
          t.scale > 1 ? "cursor-grab" : ""
        }`}
      />
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
