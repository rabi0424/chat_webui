/**
 * 空のときの案内（UI-9）。
 *
 * 文字だけが画面の中央に小さく浮いていると、壊れているのか空なのか
 * 分からない。薄い絵を1つ、1行の説明、次にやることのボタンを1つ——
 * 商用のアプリの空状態はだいたいこの3点で、それ以上は要らない。
 */
import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  /** 48px で薄く置く。 */
  icon: ReactNode;
  title: string;
  description?: string;
  /** 次にやること（Link か button を1つ）。 */
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-xs flex-col items-center px-4 text-center">
      <span aria-hidden className="grid h-12 w-12 place-items-center text-ink-3 [&>svg]:h-12 [&>svg]:w-12 [&>svg]:stroke-[1.25]">
        {icon}
      </span>
      <p className="font-display mt-4 text-base font-bold">{title}</p>
      {description && (
        <p className="mt-1 text-sm leading-relaxed text-ink-2">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** 空状態のボタン（Link にも button にも当てる）。 */
export const EMPTY_ACTION =
  "inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition hover:bg-accent/85 active:scale-95";
