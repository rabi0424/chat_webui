import { useState } from "react";
import type { ModelInfo } from "../lib/openrouter.server";
import {
  paramsForModel,
  POE_EXTRA_KEY_PATTERN,
  POE_EXTRA_PREFIX,
  type ParamDef,
  type ParamsState,
} from "../lib/params";

/** ParamsState 上のボット独自パラメータを、編集用の行に開く。 */
function extraRows(value: ParamsState): { key: string; value: string }[] {
  return Object.entries(value)
    .filter(([k]) => k.startsWith(POE_EXTRA_PREFIX))
    .map(([k, v]) => ({
      key: k.slice(POE_EXTRA_PREFIX.length),
      value: String(v),
    }));
}

/** 保存済みのボット独自パラメータの署名（外部からの変更の検出用）。 */
function extraSignature(value: ParamsState): string {
  return JSON.stringify(
    Object.entries(value)
      .filter(([k]) => k.startsWith(POE_EXTRA_PREFIX))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * ボット独自パラメータの編集。
 *
 * Poeのボットが取るパラメータは名前も値もボット任せで（画像の縦横比が
 * `aspect_ratio` だったり `aspect` だったり `size` だったり）、APIからは
 * 取得できない。決め打ちで項目を並べても外すので、名前ごと入力させる。
 * 入力途中の行はParamsStateへ書かず、ここでだけ持つ。
 */
function ExtraParams({
  value,
  onChange,
  imageHint,
}: {
  value: ParamsState;
  onChange: (next: ParamsState) => void;
  imageHint: boolean;
}) {
  const [rows, setRows] = useState(() => extraRows(value));
  // 「初期設定に戻す」など外から書き換えられたら行を作り直す。自分の
  // 書き込みでは署名が一致するので、入力途中の行は消えない。
  const [seen, setSeen] = useState(() => extraSignature(value));
  const signature = extraSignature(value);
  if (signature !== seen) {
    setSeen(signature);
    setRows(extraRows(value));
  }

  /** 名前の付いた行だけを ParamsState へ書き戻す。 */
  function commit(next: { key: string; value: string }[]) {
    setRows(next);
    const cleaned: ParamsState = {};
    for (const [k, v] of Object.entries(value)) {
      if (!k.startsWith(POE_EXTRA_PREFIX)) cleaned[k] = v;
    }
    for (const row of next) {
      const key = row.key.trim();
      if (POE_EXTRA_KEY_PATTERN.test(key)) {
        cleaned[`${POE_EXTRA_PREFIX}${key}`] = row.value;
      }
    }
    setSeen(extraSignature(cleaned));
    onChange(cleaned);
  }

  const update = (i: number, patch: Partial<{ key: string; value: string }>) =>
    commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-neutral-200/80 p-3 dark:border-white/10">
      <p className="px-1 text-sm font-medium">ボット独自パラメータ</p>
      <p className="px-1 text-xs text-neutral-400 dark:text-neutral-500">
        {imageHint
          ? "画像の縦横比など、ボット固有の設定。名前はボットごとに違う（aspect_ratio / aspect / size など）"
          : "ボット固有の設定。web_search / thinking_level など"}
        。使える名前と値は poe.com/&lt;ボット名&gt;/api で確認できます
      </p>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={row.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder="名前"
            aria-label="パラメータ名"
            className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
          />
          <input
            type="text"
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="値"
            aria-label="パラメータの値"
            className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
          />
          <button
            type="button"
            onClick={() => commit(rows.filter((_, j) => j !== i))}
            aria-label={`${row.key || "この行"}を削除`}
            className="shrink-0 rounded-lg border border-neutral-200 px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:border-white/10 dark:text-neutral-400 dark:hover:bg-white/10"
          >
            削除
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRows([...rows, { key: "", value: "" }])}
        className="rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-500 hover:bg-neutral-200 dark:bg-white/10 dark:text-neutral-400 dark:hover:bg-white/15"
      >
        パラメータを追加
      </button>
    </div>
  );
}

/**
 * 生成パラメータの編集UI（自動/手動方式）。
 * 「自動」= 値を持たない = APIに送らず、モデル本来の既定値が適用される。
 */
export function ParamsEditor({
  model,
  value,
  onChange,
}: {
  model: ModelInfo | undefined;
  value: ParamsState;
  onChange: (next: ParamsState) => void;
}) {
  const defs = paramsForModel(model);

  function setManual(def: ParamDef) {
    const initial =
      def.kind === "number"
        ? (def.defaultValue ??
          (def.key === "max_tokens"
            ? Math.min(4096, def.max)
            : def.key === "temperature" ||
                def.key === "top_p" ||
                def.key === "repetition_penalty"
              ? 1
              : def.min))
        : def.kind === "select"
          ? (def.defaultValue ?? def.options[def.options.length - 1].value)
          : "";
    onChange({ ...value, [def.key]: initial });
  }

  function setAuto(key: string) {
    const next = { ...value };
    delete next[key];
    onChange(next);
  }

  if (!model) {
    return (
      <p className="rounded-xl border border-dashed border-neutral-200 px-4 py-3 text-sm text-neutral-400 dark:border-white/15 dark:text-neutral-500">
        モデルを選択するとパラメータが表示されます
      </p>
    );
  }
  // Poeはボット固有のパラメータを一覧APIに出さないため、常に自由入力欄を添える
  const extras = model.provider === "poe" && (
    <ExtraParams
      value={value}
      onChange={onChange}
      imageHint={model.outputModalities.includes("image")}
    />
  );

  if (defs.length === 0) {
    return (
      <>
        <p className="rounded-xl border border-dashed border-neutral-200 px-4 py-3 text-sm text-neutral-400 dark:border-white/15 dark:text-neutral-500">
          このモデルの対応パラメータ情報がありません
        </p>
        {extras}
      </>
    );
  }

  return (
    <>
      <div className="space-y-1 rounded-xl border border-neutral-200/80 p-3 dark:border-white/10">
        <p className="px-1 pb-1 text-xs text-neutral-400 dark:text-neutral-500">
          「自動」はAPIに送信せず、モデル本来の既定動作に任せます
        </p>
        {defs.map((def) => {
          const manual = value[def.key] != null;
          return (
            <div
              key={def.key}
              className="flex items-center gap-3 rounded-lg px-1 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{def.label}</p>
                <p className="truncate text-xs text-neutral-400 dark:text-neutral-500">
                  {def.description}
                </p>
              </div>

              {manual ? (
                <>
                  {def.kind === "number" && (
                    <input
                      type="number"
                      value={value[def.key] as number}
                      min={def.min}
                      max={def.max}
                      step={def.step}
                      placeholder={def.hint}
                      onChange={(e) =>
                        onChange({
                          ...value,
                          [def.key]: Number(e.target.value),
                        })
                      }
                      aria-label={def.label}
                      className="w-24 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-right text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
                    />
                  )}
                  {def.kind === "select" && (
                    <select
                      value={value[def.key] as string}
                      onChange={(e) =>
                        onChange({ ...value, [def.key]: e.target.value })
                      }
                      aria-label={def.label}
                      className="rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
                    >
                      {def.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {def.kind === "text" && (
                    <input
                      type="text"
                      value={value[def.key] as string}
                      placeholder={def.placeholder}
                      onChange={(e) =>
                        onChange({ ...value, [def.key]: e.target.value })
                      }
                      aria-label={def.label}
                      className="w-36 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setAuto(def.key)}
                    aria-label={`${def.label}を自動に戻す`}
                    className="shrink-0 rounded-lg border border-neutral-200 px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:border-white/10 dark:text-neutral-400 dark:hover:bg-white/10"
                  >
                    自動に戻す
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setManual(def)}
                  aria-label={`${def.label}を手動設定`}
                  className="shrink-0 rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-500 hover:bg-neutral-200 dark:bg-white/10 dark:text-neutral-400 dark:hover:bg-white/15"
                >
                  自動
                </button>
              )}
            </div>
          );
        })}
      </div>
      {extras}
    </>
  );
}
