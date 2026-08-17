import { NumberInput } from "./NumberInput";
import type { ParamsState } from "../lib/params";
import {
  readRetryConfig,
  RETRY_CONCURRENCY_KEY,
  RETRY_DEFAULT_MAX_ATTEMPTS,
  RETRY_DEFAULT_TARGET,
  RETRY_ENABLED_KEY,
  RETRY_MAX_KEY,
  RETRY_TARGET_KEY,
} from "../lib/retry";

/** リトライ設定の1項目。未入力なら既定値がプレースホルダに出る。 */
function RetryField({
  label,
  hint,
  value,
  effective,
  min,
  max,
  onChange,
  onClear,
}: {
  label: string;
  hint: string;
  /** 実際に入力されている値。未入力なら undefined。 */
  value: number | undefined;
  /** 未入力のときに使われる値（プレースホルダに出す）。 */
  effective: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        <p className="truncate text-xs text-neutral-400 dark:text-neutral-500">
          {hint}
        </p>
      </div>
      <NumberInput
        label={label}
        value={value}
        onChange={onChange}
        onClear={onClear}
        placeholder={String(effective)}
        min={min}
        max={max}
        step={1}
        className="w-20 shrink-0 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-right text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
      />
    </div>
  );
}

/**
 * 「成功するまで生成」の設定。会話の⚙パネルとボット設定で共用する。
 *
 * 値は生成パラメータと同じ ParamsState に予約キーで置く（会話はそのまま
 * 保存され、ボットのものは会話を作るときにそのまま引き継がれる）。
 */
export function RetrySettings({
  value,
  onChange,
  ceiling,
}: {
  value: ParamsState;
  onChange: (next: ParamsState) => void;
  /** アプリ全体の試行回数の天井（設定画面）。 */
  ceiling: number;
}) {
  const config = readRetryConfig(value, ceiling);

  /** 実際に入力されている値（未入力は undefined）。 */
  const field = (key: string): number | undefined => {
    const raw = value[key];
    if (raw == null || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  /** null を渡すと未入力に戻す（既定値に従う）。 */
  const set = (key: string, next: number | null) => {
    const params = { ...value };
    if (next == null) delete params[key];
    else params[key] = next;
    onChange(params);
  };

  /** 有効/無効。有効にするときは既定値も同時に置く。 */
  const toggle = () => {
    const params = { ...value };
    if (config) {
      delete params[RETRY_ENABLED_KEY];
    } else {
      params[RETRY_ENABLED_KEY] = "on";
      params[RETRY_TARGET_KEY] ??= RETRY_DEFAULT_TARGET;
      params[RETRY_MAX_KEY] ??= Math.min(RETRY_DEFAULT_MAX_ATTEMPTS, ceiling);
    }
    onChange(params);
  };

  return (
    <div className="rounded-xl border border-neutral-200/80 p-3 dark:border-white/10">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">成功するまで生成</p>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            画像が返るまで同じ依頼を投げ直す（拒否の揺らぎ対策）
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config != null}
          aria-label="成功するまで生成"
          onClick={toggle}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            config ? "bg-accent" : "bg-neutral-300 dark:bg-neutral-600"
          }`}
        >
          <span
            className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              config ? "translate-x-[22px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      {config && (
        <div className="mt-2 space-y-1.5 border-t border-neutral-100 pt-2 dark:border-white/10">
          <RetryField
            label="目標の成功数"
            hint="ほしい応答の数"
            value={field(RETRY_TARGET_KEY)}
            effective={config.target}
            min={1}
            max={ceiling}
            onChange={(v) => set(RETRY_TARGET_KEY, v)}
            onClear={() => set(RETRY_TARGET_KEY, null)}
          />
          <RetryField
            label="上限の試行回数"
            hint={`未入力なら目標数と同じ（天井: ${ceiling}）`}
            value={field(RETRY_MAX_KEY)}
            effective={config.maxAttempts}
            min={1}
            max={ceiling}
            onChange={(v) => set(RETRY_MAX_KEY, v)}
            onClear={() => set(RETRY_MAX_KEY, null)}
          />
          <RetryField
            label="並列数"
            hint="同時に走らせる数。未入力なら目標数と同じ"
            value={field(RETRY_CONCURRENCY_KEY)}
            effective={config.concurrency}
            min={1}
            max={config.maxAttempts}
            onChange={(v) => set(RETRY_CONCURRENCY_KEY, v)}
            onClear={() => set(RETRY_CONCURRENCY_KEY, null)}
          />
        </div>
      )}
    </div>
  );
}
