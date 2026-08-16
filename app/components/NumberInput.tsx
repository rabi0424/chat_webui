import { useState } from "react";

/**
 * 数値の入力欄。入力途中の空欄を許す。
 *
 * 値をそのまま value 属性へ流すと、消した瞬間に 0 や NaN へ丸められて
 * 書き換えが非常にしづらい（「30」を「5」にしたいのに一度消せない）。
 * 表示用の文字列を内部に持ち、数値として読めるあいだだけ親へ通知する。
 *
 * 空欄の扱いは2通り。
 * - onClear あり: 空欄そのものが「未設定」として意味を持つ（既定値に従う）。
 * - onClear なし: 入力途中の状態とみなし、離れたときに元の値へ戻す。
 */
export function NumberInput({
  value,
  onChange,
  onClear,
  placeholder,
  min,
  max,
  step,
  label,
  className,
}: {
  /** 未設定は undefined。 */
  value: number | undefined;
  onChange: (value: number) => void;
  /** 空欄にされたときの処理。渡すと空欄を保持できる。 */
  onClear?: () => void;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  className?: string;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  // 外から値が変わったら追従する（自分の入力では一致するので消えない）
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value == null ? "" : String(value));
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      value={text}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw.trim() === "") {
          onClear?.();
          return;
        }
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => {
        if (text.trim() !== "" || onClear) return;
        // 空欄のまま離れたら、直前の値へ戻す
        setText(value == null ? "" : String(value));
      }}
      aria-label={label}
      className={className}
    />
  );
}
