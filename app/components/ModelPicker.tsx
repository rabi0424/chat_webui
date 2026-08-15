import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo } from "../lib/openrouter.server";
import { IconChevronDown } from "./icons";
import { GLASS_PANEL } from "../lib/ui";

function formatPricePerMillion(perToken: string): string {
  const n = Number(perToken) * 1_000_000;
  if (!Number.isFinite(n) || n === 0) return "$0";
  return `$${n < 10 ? n.toFixed(2) : Math.round(n)}`;
}

function formatContext(len: number): string {
  if (len >= 1_000_000) return `${(len / 1_000_000).toFixed(1)}M`;
  if (len >= 1_000) return `${Math.round(len / 1_000)}K`;
  return String(len);
}

export function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** モバイルでは画面幅にフィットするfixed配置にする（横はみ出し防止）。 */
  const [mobileTop, setMobileTop] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = models.find((m) => m.id === value);

  const openPicker = () => {
    if (window.innerWidth < 640) {
      const rect = containerRef.current?.getBoundingClientRect();
      setMobileTop((rect?.bottom ?? 56) + 6);
    } else {
      setMobileTop(null);
    }
    setOpen(true);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [models, query]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPicker())}
        className="flex max-w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 active:scale-[0.98] dark:text-neutral-200 dark:hover:bg-neutral-800"
      >
        <span className="truncate">{selected?.name ?? value ?? "モデルを選択"}</span>
        <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
      </button>

      {open && (
        <div
          style={mobileTop != null ? { top: mobileTop } : undefined}
          className={`z-30 flex max-h-[60vh] flex-col overflow-hidden rounded-xl animate-pop ${GLASS_PANEL} ${
            mobileTop != null
              ? "fixed inset-x-2 origin-top"
              : "absolute left-0 mt-1 w-[min(90vw,26rem)] origin-top-left"
          }`}
        >
          <div className="border-b border-neutral-100 p-2 dark:border-white/10">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="モデルを検索…"
              className="w-full rounded-lg bg-neutral-100 px-3 py-2 text-base outline-none placeholder:text-neutral-400 sm:text-sm dark:bg-white/10 dark:text-neutral-100"
            />
          </div>
          <ul className="overflow-y-auto overscroll-contain p-1">
            {filtered.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-neutral-400">
                該当するモデルがありません
              </li>
            )}
            {filtered.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={`w-full rounded-lg px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-white/10 ${
                    m.id === value ? "bg-neutral-100 dark:bg-white/10" : ""
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                      {m.name}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      {m.provider === "poe" && (
                        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                          Poe
                        </span>
                      )}
                      {m.inputModalities.includes("image") && (
                        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                          画像
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="mt-0.5 flex gap-3 text-xs text-neutral-400 dark:text-neutral-500">
                    <span className="truncate">{m.id}</span>
                  </div>
                  <div className="mt-0.5 flex gap-3 text-xs text-neutral-500 dark:text-neutral-400">
                    {m.provider === "poe" ? (
                      <span>サブスクのポイントで課金</span>
                    ) : (
                      <>
                        <span>{formatContext(m.contextLength)} ctx</span>
                        <span>
                          入 {formatPricePerMillion(m.promptPrice)}/M · 出{" "}
                          {formatPricePerMillion(m.completionPrice)}/M
                        </span>
                      </>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
