import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo } from "../lib/openrouter.server";

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
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = models.find((m) => m.id === value);

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
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        <span className="truncate">{selected?.name ?? value ?? "モデルを選択"}</span>
        <svg className="h-4 w-4 shrink-0 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-1 flex max-h-[60vh] w-[min(90vw,26rem)] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <div className="border-b border-gray-100 p-2 dark:border-gray-800">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="モデルを検索…"
              className="w-full rounded-lg bg-gray-100 px-3 py-2 text-sm outline-none placeholder:text-gray-400 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>
          <ul className="overflow-y-auto overscroll-contain p-1">
            {filtered.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-gray-400">
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
                  className={`w-full rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800 ${
                    m.id === value ? "bg-gray-100 dark:bg-gray-800" : ""
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                      {m.name}
                    </span>
                    {m.inputModalities.includes("image") && (
                      <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                        画像
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex gap-3 text-xs text-gray-400 dark:text-gray-500">
                    <span className="truncate">{m.id}</span>
                  </div>
                  <div className="mt-0.5 flex gap-3 text-xs text-gray-500 dark:text-gray-400">
                    <span>{formatContext(m.contextLength)} ctx</span>
                    <span>
                      入 {formatPricePerMillion(m.promptPrice)}/M · 出{" "}
                      {formatPricePerMillion(m.completionPrice)}/M
                    </span>
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
