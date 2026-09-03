import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShortcut } from "../lib/use-shortcut";
import { createPortal } from "react-dom";
import type { ModelInfo } from "../lib/openrouter.server";
import { useEscapeToClose } from "../lib/dismiss";
import { IconChevronDown, IconX } from "./icons";
import { GLASS_PANEL, TERSE_INPUT } from "../lib/ui";
import { rankedModelIds } from "../lib/recent-models";
import { isPoeModel, POE_PREFIX } from "../lib/constants";

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

/**
 * プロバイダの色。チップの左端の小さな四角に使う。
 *
 * モデル名の「Anthropic: 」のような接頭を文字で出す代わりに色で示す
 * （チップは入力欄の中に居るので、文字数を節約したい）。知らない
 * プロバイダは灰。
 */
export function providerColor(modelId: string): string {
  const bare = isPoeModel(modelId) ? modelId.slice(POE_PREFIX.length) : modelId;
  const vendor = bare.split("/")[0]?.toLowerCase() ?? "";
  if (vendor.startsWith("anthropic")) return "#d97757";
  if (vendor.startsWith("openai")) return "#10a37f";
  if (vendor.startsWith("google")) return "#4285f4";
  if (vendor.startsWith("x-ai")) return "#1c1c1e";
  if (vendor.startsWith("meta")) return "#0668e1";
  if (vendor.startsWith("mistral")) return "#ff7000";
  if (vendor.startsWith("deepseek")) return "#4d6bfe";
  if (isPoeModel(modelId)) return "#7c3aed";
  return "#8e8e93";
}

/** チップに出す短い名前。「Anthropic: Claude Sonnet 4」→「Claude Sonnet 4」。 */
export function shortModelName(m: ModelInfo | undefined, fallback: string): string {
  const name = m?.name ?? fallback;
  const i = name.indexOf(": ");
  return i > 0 ? name.slice(i + 2) : name;
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
        className={`relative w-full rounded-lg px-3 py-2 text-left hover:bg-hover ${
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
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: providerColor(m.id) }}
            />
            <span className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
              {m.name}
            </span>
          </span>
          <span className="flex shrink-0 gap-1">
            {isNew && (
              <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-accent-fg">
                NEW
              </span>
            )}
            {m.provider === "poe" && (
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-2 dark:bg-neutral-800">
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
        <div className="mt-0.5 flex gap-3 text-xs text-ink-3">
          <span className="truncate">{m.id}</span>
        </div>
        <div className="mt-0.5 flex gap-3 text-xs text-ink-2">
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

/** 一覧の高さの上限（画面の比率）。上に開くか下に開くかの判断にも使う。 */
const PANEL_MAX_RATIO = 0.6;

export function ModelPicker({
  models,
  value,
  newModelDays,
  onChange,
  variant = "plain",
  leading,
  onClear,
  clearLabel,
}: {
  models: ModelInfo[];
  value: string;
  /** 公開から何日間「NEW」を出すか（0 = 出さない）。 */
  newModelDays: number;
  onChange: (id: string) => void;
  /**
   * 見た目。
   * - plain: 枠の無い文字（設定画面の中など、周りが枠を持つ場所）
   * - chip:  入力欄の中のチップ（薄い塗り・プロバイダの色・短い名前）
   * - field: 設定画面の入力欄と同じ形の、セレクト風のボタン
   */
  variant?: "plain" | "chip" | "field";
  /** チップの先頭に置くもの（ボットの印など）。 */
  leading?: React.ReactNode;
  /** チップの末尾に × を出し、押したときに呼ぶ（ボットの選択を外す）。 */
  onClear?: () => void;
  clearLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** よく使う順のモデルID。localStorage 由来なのでパネルを開くときに読む。 */
  const [recentIds, setRecentIds] = useState<string[]>([]);
  /**
   * パネルの fixed 配置座標。ボタン位置から計算し、画面内へクランプする。
   * パネルはポータルで body 直下に描画する（後述のコメント参照）。
   *
   * 上下どちらへ開くかもここで決める。入力欄の中のチップは画面の下端に
   * 居るので、下へ開くと一覧が画面の外へ出る。下に余裕が無ければ
   * ボタンの上へ開く（bottom を基準にする）。
   */
  const [pos, setPos] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
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
    const left = Math.max(
      margin,
      Math.min(rect?.left ?? margin, window.innerWidth - width - margin),
    );
    const wanted = window.innerHeight * PANEL_MAX_RATIO;
    const below = window.innerHeight - (rect?.bottom ?? 56) - margin;
    const above = (rect?.top ?? 0) - margin;
    if (below >= wanted || below >= above) {
      setPos({
        left,
        width,
        top: (rect?.bottom ?? 56) + 6,
        maxHeight: Math.min(wanted, below - 6),
      });
    } else {
      setPos({
        left,
        width,
        bottom: window.innerHeight - (rect?.top ?? 0) + 6,
        maxHeight: Math.min(wanted, above - 6),
      });
    }
    setRecentIds(rankedModelIds());
    setOpen(true);
  };
  // ⌘⇧M。入力欄のチップ（会話の中のもの）だけが受ける——設定画面の
  // 既定モデルの欄まで開くと、どちらが開いたのか分からない
  useShortcut("model", () => { if (!open) openPicker(); }, variant === "chip");

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
    // 描画のたびに現在時刻を読むが、サーバー側では models が空で印が
    // 付かないため、ハイドレーションの不一致にはならない（上の説明のとおり）
    // eslint-disable-next-line react-hooks/purity
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
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  /*
   * Escape は共通の重なり順（dismiss の openLayers）へ預ける。
   *
   * 自前で keydown を見ていたころは、この一覧の上に何か重なっていても
   * 両方が反応し、一度の Escape で2枚まとめて閉じていた（監査 C-7）。
   */
  const close = useCallback(() => setOpen(false), []);
  useEscapeToClose(open, close);

  // 一覧がまだ届いていない・値が空のときは、四角だけが残らないよう文言を出す
  const label = !value
    ? "モデルを選択"
    : variant === "chip"
      ? shortModelName(selected, value)
      : selected?.name ?? value;

  const triggerClass =
    variant === "chip"
      ? "flex h-8 max-w-full items-center gap-1.5 rounded-full bg-black/[0.05] pl-2.5 pr-2 text-[13px] font-medium text-neutral-700 transition-colors hover:bg-black/[0.08] active:scale-[0.98] dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/15"
      : variant === "field"
        ? "flex max-w-full items-center gap-2 rounded-lg border border-line bg-neutral-50 py-1.5 pl-2.5 pr-2 text-sm text-neutral-800 transition-colors hover:bg-hover active:scale-[0.98] dark:bg-white/5 dark:text-neutral-100"
        : "flex max-w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-hover active:scale-[0.98] dark:text-neutral-200";

  return (
    <div ref={containerRef} className="relative flex min-w-0 items-center">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPicker())}
        title={selected?.name}
        className={triggerClass}
      >
        {leading}
        {variant !== "plain" && (
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ backgroundColor: providerColor(value) }}
          />
        )}
        <span className="truncate">{label}</span>
        <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
      </button>
      {onClear && variant === "chip" && (
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel ?? "選択を解除"}
          title={clearLabel ?? "選択を解除"}
          className="ml-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-neutral-400 hover:bg-black/[0.06] hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-200"
        >
          <IconX className="h-3.5 w-3.5" />
        </button>
      )}

      {/*
        パネルはポータルで body 直下に描画する。ヘッダー（スクロール時に
        backdrop-blur が付く）の子孫に置くと、「backdrop-filter 要素の
        子孫では backdrop-filter が効かない」ブラウザの挙動により、
        スクロール中に開いたときだけパネルのブラーが消えてしまうため。
        入力欄（同じくガラス面）の中に居るときも同じ。
      */}
      {open && pos != null && createPortal(
        <div
          ref={panelRef}
          style={{
            left: pos.left,
            top: pos.top,
            bottom: pos.bottom,
            width: pos.width,
            maxHeight: pos.maxHeight,
          }}
          className={`fixed z-30 flex flex-col overflow-hidden rounded-xl animate-pop ${
            pos.bottom != null ? "origin-bottom" : "origin-top"
          } ${GLASS_PANEL}`}
        >
          <div className="border-b border-line p-2">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="モデルを検索…"
              aria-label="モデルを検索"
              {...TERSE_INPUT}
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
                <li className="px-3 pb-1 pt-2 text-[11px] font-medium text-ink-3">
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
                  className="mx-3 my-1 border-t border-line"
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
