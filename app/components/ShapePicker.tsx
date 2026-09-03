/**
 * 画像の形（アスペクト比・解像度）の選択。
 *
 * "1536x1024" と "1024x1536" は文字列としてはほとんど同じ見た目で、
 * <select> に並べても縦長か横長かが分からない。ここでは値そのものを
 * 長方形として描き、比と向き（3:2 横長）を添えて選ばせる。
 *
 * アイコンは値から計算した長方形なので、固定パスの icons.tsx には置かない。
 */
import {
  orientationLabel,
  parseShape,
  shapeHint,
  type Shape,
} from "../lib/aspect";

/** アイコンの一辺（px 相当。viewBox 20 に対して余白を残す）。 */
const BOX = 20;
const LONG = 17;
/**
 * 極端な比（21:9 など）でも短辺が線に潰れないよう下限を置く。
 * 潰れると「読めない」ではなく「間違った形」に見えるため。
 */
const MIN = 4;

/** 値の形を描く長方形。読めない値（"auto" など）は破線の四角にする。 */
export function ShapeIcon({
  shape,
  className = "h-5 w-5 shrink-0",
}: {
  shape: Shape | null;
  className?: string;
}) {
  const long = Math.max(shape?.width ?? 1, shape?.height ?? 1);
  const w = shape ? Math.max(MIN, (shape.width / long) * LONG) : LONG;
  const h = shape ? Math.max(MIN, (shape.height / long) * LONG) : LONG;
  return (
    <svg viewBox={`0 0 ${BOX} ${BOX}`} className={className} aria-hidden>
      <rect
        x={(BOX - w) / 2}
        y={(BOX - h) / 2}
        width={w}
        height={h}
        rx={1.5}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray={shape ? undefined : "3 2"}
      />
    </svg>
  );
}

/**
 * 形の選択肢を、長方形付きのボタンで並べる。
 *
 * 選択肢の数はボット任せ（4つのことも10以上のこともある）なので折り返す。
 */
export function ShapePicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="mt-2 flex flex-wrap gap-1.5"
    >
      {options.map((o) => {
        const shape = parseShape(o.value);
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition ${
              on
                ? "border-accent/60 bg-accent/10 text-ink"
                : "border-line text-ink-2 hover:bg-hover"
            }`}
          >
            <ShapeIcon shape={shape} />
            <span className="flex min-w-0 flex-col">
              <span className="block text-xs font-medium tabular-nums">
                {o.label}
              </span>
              <span className="block text-[11px] text-ink-3">
                {shape ? shapeHint(o.value, shape) : "自動"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 自由入力の欄に添える形の確認。読めない値のときは何も出さない。 */
export function ShapePreview({ value }: { value: string }) {
  const shape = parseShape(value);
  if (!shape) return null;
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-[11px] text-ink-3"
      title={shapeHint(value, shape)}
    >
      <ShapeIcon shape={shape} className="h-4 w-4" />
      {orientationLabel(shape.orientation)}
    </span>
  );
}
