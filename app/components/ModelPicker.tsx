import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelInfo } from "../lib/openrouter.server";
import { IconChevronDown } from "./icons";
import { GLASS_PANEL } from "../lib/ui";
import { rankedModelIds } from "../lib/recent-models";

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

/** 「最近よく使うモデル」に出す件数。 */
const RECENT_LIMIT = 5;

/**
 * 公開されたばかりのモデルか（`createdAt` は秒。0 は日付不明）。
 *
 * 判定はモデル一覧の公開日（OpenRouter の `created` / Poe の同名フィールド）
 * だけで行う。手で新着リストを持つと必ず腐るので、上流が申告する日付を
 * そのまま使い、日が経てば自然に外れるようにしてある。
 * 何日出すかは設定画面（モデル一覧 > 新着として出す日数）で変えられる。
 */
function isNewModel(m: ModelInfo, now: number, windowDays: number): boolean {
  if (!m.createdAt || windowDays <= 0) return false;
  const published = m.createdAt * 1000;
  return (
    published <= now && now - published < windowDays * 24 * 60 * 60 * 1000
  );
}

/** 一覧の1行。よく使う節と一覧本体で同じ見た目を使う。 */
function ModelRow({
  model: m,
  selected,
  isNew,
  onSelect,
}: {
  model: ModelInfo;
  selected: boolean;
  /** 公開されたばかり。左端のバーと NEW バッジで目立たせる。 */
  isNew: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(m.id)}
        className={`relative w-full rounded-lg px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-white/10 ${
          selected ? "bg-neutral-100 dark:bg-white/10" : ""
        } ${isNew ? "pl-4" : ""}`}
      >
        {/* 新着の印。行の左端に立てたアクセントのバー */}
        {isNew && (
          <span
            aria-hidden
            className="absolute inset-y-1.5 left-1 w-1 rounded-full bg-accent"
          />
        )}
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {m.name}
          </span>
          <span className="flex shrink-0 gap-1">
            {isNew && (
              <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-accent-fg">
                NEW
              </span>
            )}
            {m.provider === "poe" && (
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                Poe
              </span>
            )}
            {m.inputModalities.includes("image") && (
              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-ink">
                画像
              </span>
            )}
          </span>
        </div>
        <div className="mt-0.5 flex gap-3 text-xs text-neutral-400 dark:text-neutral-500">
          <span className="truncate">{m.id}</span>
        </div>
        <div className="mt-0.5 flex gap-3 text-xs text-neutral-500 dark:text-neutral-400">
          {m.contextLength > 0 && (
            <span>{formatContext(m.contextLength)} ctx</span>
          )}
          {/* Poeは価格を返さないことがある。その場合は課金方法だけ示す */}
          {m.provider === "poe" && Number(m.promptPrice) === 0 ? (
            <span>ポイントで課金</span>
          ) : (
            <span>
              入 {formatPricePerMillion(m.promptPrice)}/M · 出{" "}
              {formatPricePerMillion(m.completionPrice)}/M
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

export function ModelPicker({
  models,
  value,
  newModelDays,
  onChange,
}: {
  models: ModelInfo[];
  value: string;
  /** 公開から何日間「NEW」を出すか（0 = 出さない）。 */
  newModelDays: number;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** よく使う順のモデルID。localStorage 由来なのでパネルを開くときに読む。 */
  const [recentIds, setRecentIds] = useState<string[]>([]);
  /**
   * パネルの fixed 配置座標。ボタン位置から計算し、画面内へクランプする。
   * パネルはポータルで body 直下に描画する（後述のコメント参照）。
   */
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = models.find((m) => m.id === value);

  const openPicker = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    const margin = 8;
    const width =
      window.innerWidth < 640
        ? window.innerWidth - margin * 2
        : Math.min(window.innerWidth * 0.9, 416); // 26rem
    setPos({
      left: Math.max(
        margin,
        Math.min(rect?.left ?? margin, window.innerWidth - width - margin),
      ),
      top: (rect?.bottom ?? 56) + 6,
      width,
    });
    setRecentIds(rankedModelIds());
    setOpen(true);
  };

  const select = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  /**
   * スペース区切りのAND検索。各語がID・名前のどこかに含まれれば良い
   * （OpenRouterとPoeで命名規則が違うため、"opus 4.6" のような
   * 語順・区切りに依存しない検索ができるように）。
   */
  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/[\s　]+/).filter(Boolean);
    if (terms.length === 0) return models;
    return models.filter((m) => {
      const haystack = `${m.id} ${m.name}`.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  }, [models, query]);

  /**
   * 新着モデルのID。一覧が入れ替わったときだけ数え直す
   * （サーバー側では models が空なので、印は付かない = 不一致も出ない）。
   */
  const newModelIds = useMemo(() => {
    const now = Date.now();
    return new Set(
      models.filter((m) => isNewModel(m, now, newModelDays)).map((m) => m.id),
    );
  }, [models, newModelDays]);

  /** よく使う順の上位。提供終了などで一覧に無いIDは落とす。 */
  const recent = useMemo(() => {
    if (query.trim() !== "") return [];
    return recentIds
      .map((id) => models.find((m) => m.id === id))
      .filter((m): m is ModelInfo => m != null)
      .slice(0, RECENT_LIMIT);
  }, [models, recentIds, query]);

  useEffect(() => {
    if (!open) return;
    // タッチ環境では自動フォーカスしない。キーボードが開くと
    // Safariが「入力欄を見せるためのページ全体のパン」を優先し、
    // 一覧内のスクロールがそちらへ取られてしまうため
    // （検索したいときだけタップしてもらう）。
    if (!window.matchMedia("(pointer: coarse)").matches) {
      searchRef.current?.focus();
    }
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (
        !containerRef.current?.contains(t) &&
        !panelRef.current?.contains(t)
      ) {
        setOpen(false);
      }
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

      {/*
        パネルはポータルで body 直下に描画する。ヘッダー（スクロール時に
        backdrop-blur が付く）の子孫に置くと、「backdrop-filter 要素の
        子孫では backdrop-filter が効かない」ブラウザの挙動により、
        スクロール中に開いたときだけパネルのブラーが消えてしまうため。
      */}
      {open && pos != null && createPortal(
        <div
          ref={panelRef}
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          className={`fixed z-30 flex max-h-[60vh] origin-top flex-col overflow-hidden rounded-xl animate-pop ${GLASS_PANEL}`}
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
          {/* min-h-0: これが無いとflex子はコンテンツ高さより縮めず、
              一覧自体がスクロール不能になってタッチが背面へ抜ける。
              onTouchMove: 検索中に一覧をスクロールし始めたら
              キーボードを閉じる（スクロールがパンに取られるのを防ぐ） */}
          <ul
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
            onTouchMove={() => searchRef.current?.blur()}
          >
            {filtered.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-neutral-400">
                該当するモデルがありません
              </li>
            )}
            {/*
              よく使うモデルの節。検索中は出さない（打ち込んだ語に対する
              並びが一定になるほうが探しやすいため）。一覧本体からは
              除かず、上に複製して置くだけにする。
            */}
            {recent.length > 0 && (
              <>
                <li className="px-3 pb-1 pt-2 text-[11px] font-medium text-neutral-400 dark:text-neutral-500">
                  最近よく使うモデル
                </li>
                {recent.map((m) => (
                  <ModelRow
                    key={`recent-${m.id}`}
                    model={m}
                    selected={m.id === value}
                    isNew={newModelIds.has(m.id)}
                    onSelect={select}
                  />
                ))}
                <li
                  role="separator"
                  className="mx-3 my-1 border-t border-neutral-100 dark:border-white/10"
                />
              </>
            )}
            {filtered.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                selected={m.id === value}
                isNew={newModelIds.has(m.id)}
                onSelect={select}
              />
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}
