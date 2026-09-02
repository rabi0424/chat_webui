/**
 * 設定画面とボットの編集で使う操作部品。
 *
 * 部品は5つに絞る——セグメント（少数の選択肢）、スイッチ（真偽）、
 * ステッパー付きの数値、セレクト風のボタン（ModelPicker の field 変種）、
 * 色見本（AccentPicker）。以前は同じ画面にネイティブの <select>・自前の
 * 丸・自前のセグメントが並び、3つの流儀が混ざっていた。
 *
 * 形は iOS の設定と同じ「グループ化された一覧」に載る前提で、行の右端に
 * 収まる大きさにしてある。
 */
import { NumberInput } from "./NumberInput";
import { IconCheck } from "./icons";

/** 文字や数字の入力欄の見た目。設定・ボット編集・パラメータで共通。 */
export const FIELD =
  "rounded-lg border border-line bg-neutral-50 px-2.5 py-1.5 text-base outline-none placeholder:text-neutral-400 focus:border-accent/60 sm:text-sm dark:bg-white/5";

export const FIELD_AREA =
  "w-full resize-y rounded-xl border border-line bg-neutral-50 px-3 py-2 text-base outline-none placeholder:text-neutral-400 focus:border-accent/60 sm:text-sm dark:bg-white/5";

/**
 * セグメント。選択肢が2〜4つで、どれか1つを選ぶもの（テーマ・文字サイズ・
 * ホームの様式）。選んでいるものは白い板で浮く（macOS の segmented control）。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-lg bg-black/[0.06] p-0.5 dark:bg-white/10"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-sm transition touch:py-2 ${
              on
                ? "bg-white font-medium text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-50"
                : "text-ink-2 hover:text-neutral-800 dark:hover:text-neutral-100"
            }`}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** スイッチ。真偽の設定（今月だけ上限を解除、Web検索）。 */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-neutral-300 dark:bg-neutral-600"
      }`}
    >
      <span
        className={`absolute left-0 top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-[20px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

/**
 * ステッパー付きの数値。− と ＋ で1段ずつ動かせ、数字を直接打つこともできる。
 * 指の端末では数字を打つより ± のほうが速いことが多い。
 */
export function Stepper({
  value,
  min,
  max,
  step,
  onChange,
  label,
  width = "w-20",
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  label: string;
  width?: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  /** 浮動小数の足し引きで 0.30000000000000004 にならないよう丸める */
  const decimals = (String(step).split(".")[1] ?? "").length;
  const round = (n: number) => Number(n.toFixed(decimals));
  const btn =
    "grid h-9 w-9 place-items-center text-ink-2 hover:bg-hover disabled:opacity-30";
  return (
    <div className="inline-flex items-center overflow-hidden rounded-lg border border-line bg-neutral-50 dark:bg-white/5">
      <button
        type="button"
        onClick={() => onChange(clamp(round(value - step)))}
        disabled={value <= min}
        aria-label={`${label}を減らす`}
        className={btn}
      >
        −
      </button>
      <NumberInput
        label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(v) => onChange(clamp(v))}
        className={`${width} border-x border-line bg-transparent px-2 py-1.5 text-center text-base tabular-nums outline-none sm:text-sm`}
      />
      <button
        type="button"
        onClick={() => onChange(clamp(round(value + step)))}
        disabled={value >= max}
        aria-label={`${label}を増やす`}
        className={btn}
      >
        ＋
      </button>
    </div>
  );
}

/** 「保存しました」の印。変えた行の右端に 1.5 秒だけ出す。 */
export function SavedMark({ shown }: { shown: boolean }) {
  return (
    <span
      aria-live="polite"
      className={`flex items-center gap-1 text-xs text-green-600 transition-opacity dark:text-green-400 ${
        shown ? "opacity-100" : "opacity-0"
      }`}
    >
      <IconCheck className="h-3.5 w-3.5" />
      {shown ? "保存しました" : ""}
    </span>
  );
}

/**
 * グループ化された一覧（iOS の設定の形）。角丸の白い塊に、行が線で区切られて
 * 並ぶ。見出しと注記は塊の上に置く——読む順が「見出し → 注記 → 項目」に
 * なる（以前は注記が塊の下にあり、読み終えてから前提を知ることになっていた）。
 */
export function Group({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-7">
      <h2 className="font-display px-1 text-[15px] font-bold tracking-tight">
        {title}
      </h2>
      {note && (
        <p className="mb-2 mt-0.5 px-1 text-xs leading-relaxed text-ink-2">
          {note}
        </p>
      )}
      <div className="mt-2 divide-y divide-black/[0.06] rounded-2xl border border-black/[0.06] bg-white dark:divide-white/[0.08] dark:border-white/[0.08] dark:bg-white/[0.04]">
        {children}
      </div>
    </section>
  );
}

/**
 * 一覧の1行。左に項目名と説明、右に操作。
 *
 * iPhone では行の高さを 44px 以上にする。`stack` は操作が横に収まらない
 * もの（文字欄・パラメータ一覧）で、操作を下の段に置く。
 */
export function Row({
  label,
  description,
  children,
  saved = false,
  stack = false,
}: {
  label: string;
  description?: string;
  children?: React.ReactNode;
  /** この行の値を保存したばかり。右端に印を出す。 */
  saved?: boolean;
  stack?: boolean;
}) {
  return (
    <div className={`px-4 py-3 ${stack ? "" : "flex min-h-[3.25rem] items-center gap-4"}`}>
      <div className={`min-w-0 ${stack ? "" : "flex-1"}`}>
        <p className="text-sm font-medium">{label}</p>
        {description && (
          <p className="text-xs leading-relaxed text-ink-2">
            {description}
          </p>
        )}
      </div>
      {children && (
        <div
          /*
           * 横並びのときも、狭い画面では右側を6割までに抑える。抑えないと
           * 長いモデル名の欄が幅を取り、左の見出しが1文字ずつ折れる。
           */
          className={`flex items-center gap-3 ${stack ? "mt-2" : "shrink-0 max-w-[60%] sm:max-w-none"}`}
        >
          <SavedMark shown={saved} />
          {children}
        </div>
      )}
    </div>
  );
}
