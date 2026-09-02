import { useState } from "react";
import type { ModelInfo } from "../lib/openrouter.server";
import { TERSE_INPUT } from "../lib/ui";
import { isShapeChoice } from "../lib/aspect";
import { ShapePicker, ShapePreview } from "./ShapePicker";
import {
  paramsForModel,
  POE_EXTRA_KEY_PATTERN,
  POE_EXTRA_PREFIX,
  type ParamDef,
  type ParamsState,
} from "../lib/params";

/** この欄が扱う項目（Poeが公開していない名前）だけを取り出す。 */
function ownEntries(
  value: ParamsState,
  known: Set<string>,
): [string, number | string][] {
  return Object.entries(value).filter(
    ([k]) => k.startsWith(POE_EXTRA_PREFIX) && !known.has(k),
  );
}

/** ParamsState 上のボット独自パラメータを、編集用の行に開く。 */
function extraRows(
  value: ParamsState,
  known: Set<string>,
): { key: string; value: string }[] {
  return ownEntries(value, known).map(([k, v]) => ({
    key: k.slice(POE_EXTRA_PREFIX.length),
    value: String(v),
  }));
}

/** 保存済みの項目の署名（外部からの変更の検出用）。 */
function extraSignature(value: ParamsState, known: Set<string>): string {
  return JSON.stringify(
    ownEntries(value, known).sort(([a], [b]) => a.localeCompare(b)),
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
  knownNames,
  imageHint,
}: {
  value: ParamsState;
  onChange: (next: ParamsState) => void;
  /** Poeが公開しているパラメータのキー。上の一覧が担当するので触らない。 */
  knownNames: Set<string>;
  imageHint: boolean;
}) {
  const [rows, setRows] = useState(() => extraRows(value, knownNames));
  // 「初期設定に戻す」など外から書き換えられたら行を作り直す。自分の
  // 書き込みでは署名が一致するので、入力途中の行は消えない。
  const [seen, setSeen] = useState(() => extraSignature(value, knownNames));
  const signature = extraSignature(value, knownNames);
  if (signature !== seen) {
    setSeen(signature);
    setRows(extraRows(value, knownNames));
  }

  /** 名前の付いた行だけを ParamsState へ書き戻す。 */
  function commit(next: { key: string; value: string }[]) {
    setRows(next);
    const cleaned: ParamsState = {};
    for (const [k, v] of Object.entries(value)) {
      // 公開パラメータ側の値は上の一覧が持っているのでそのまま残す
      if (!k.startsWith(POE_EXTRA_PREFIX) || knownNames.has(k)) cleaned[k] = v;
    }
    for (const row of next) {
      const key = row.key.trim();
      if (
        POE_EXTRA_KEY_PATTERN.test(key) &&
        !knownNames.has(`${POE_EXTRA_PREFIX}${key}`)
      ) {
        cleaned[`${POE_EXTRA_PREFIX}${key}`] = row.value;
      }
    }
    setSeen(extraSignature(cleaned, knownNames));
    onChange(cleaned);
  }

  const update = (i: number, patch: Partial<{ key: string; value: string }>) =>
    commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-neutral-200/80 p-3 dark:border-white/10">
      <p className="px-1 text-sm font-medium">ボット独自パラメータ</p>
      <p className="px-1 text-xs text-ink-3">
        {knownNames.size > 0
          ? "このボットが公開していない名前です。このまま送るとエラーになるので削除してください"
          : imageHint
            ? "画像サイズなど、ボット固有の設定。使える名前と値は poe.com/<ボット名>/api で確認できます"
            : "ボット固有の設定。使える名前と値は poe.com/<ボット名>/api で確認できます"}
      </p>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={row.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder="名前"
            aria-label="パラメータ名"
            {...TERSE_INPUT}
            className="min-w-0 flex-1 rounded-lg border border-line bg-neutral-50 px-2 py-1.5 text-base outline-none focus:border-accent/60 sm:text-sm dark:bg-white/5"
          />
          <input
            type="text"
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="値"
            aria-label="パラメータの値"
            {...TERSE_INPUT}
            className="min-w-0 flex-1 rounded-lg border border-line bg-neutral-50 px-2 py-1.5 text-base outline-none focus:border-accent/60 sm:text-sm dark:bg-white/5"
          />
          {/* 手で "16:9" と打ったときも、縦横どちらになるかをその場で見せる */}
          <ShapePreview value={row.value} />
          <button
            type="button"
            onClick={() => commit(rows.filter((_, j) => j !== i))}
            aria-label={`${row.key || "この行"}を削除`}
            className="shrink-0 rounded-lg border border-line px-2 py-1.5 text-xs text-ink-2 hover:bg-hover"
          >
            削除
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRows([...rows, { key: "", value: "" }])}
        className="rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-neutral-200 dark:bg-white/10 dark:hover:bg-white/15"
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
      <p className="rounded-xl border border-dashed border-neutral-200 px-4 py-3 text-sm text-ink-3 dark:border-white/15">
        モデルを選択するとパラメータが表示されます
      </p>
    );
  }
  /*
   * 自由入力の欄は、Poeがそのボットのパラメータを公開していないときの
   * 逃げ道。公開されていれば上の一覧が自動で並ぶので出さない。
   * ただし公開一覧に無い名前が会話に残っている場合（ボット側の変更や、
   * 名前を手入力していた頃の設定）は、消せるように出す。
   */
  const published = new Set(
    (model.botParameters ?? []).map((p) => `${POE_EXTRA_PREFIX}${p.name}`),
  );
  const hasUnknownExtras = Object.keys(value).some(
    (k) => k.startsWith(POE_EXTRA_PREFIX) && !published.has(k),
  );
  const extras = model.provider === "poe" &&
    (published.size === 0 || hasUnknownExtras) && (
      <ExtraParams
        value={value}
        onChange={onChange}
        knownNames={published}
        imageHint={model.outputModalities.includes("image")}
      />
    );

  if (defs.length === 0) {
    return (
      <>
        <p className="rounded-xl border border-dashed border-neutral-200 px-4 py-3 text-sm text-ink-3 dark:border-white/15">
          このモデルの対応パラメータ情報がありません
        </p>
        {extras}
      </>
    );
  }

  return (
    <>
      <div className="space-y-1 rounded-xl border border-neutral-200/80 p-3 dark:border-white/10">
        <p className="px-1 pb-1 text-xs text-ink-3">
          「自動」はAPIに送信せず、モデル本来の既定動作に任せます
        </p>
        {defs.map((def) => {
          const manual = value[def.key] != null;
          /*
           * 形（アスペクト比・解像度）の選択肢は <select> にしない。
           * "1536x1024" と "1024x1536" は並べても見分けが付かず、
           * 縦長・横長は形を描いて初めて分かる。
           */
          const shapes =
            def.kind === "select" &&
            isShapeChoice(def.options.map((o) => o.value));
          const head = (
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{def.label}</p>
              <p className="truncate text-xs text-ink-3">{def.description}</p>
            </div>
          );
          const toAuto = (
            <button
              type="button"
              onClick={() => setAuto(def.key)}
              aria-label={`${def.label}を自動に戻す`}
              className="shrink-0 rounded-lg border border-line px-2 py-1.5 text-xs text-ink-2 hover:bg-hover"
            >
              自動に戻す
            </button>
          );

          if (manual && shapes && def.kind === "select") {
            return (
              <div key={def.key} className="rounded-lg px-1 py-1.5">
                <div className="flex items-center gap-3">
                  {head}
                  {toAuto}
                </div>
                <ShapePicker
                  label={def.label}
                  options={def.options}
                  value={String(value[def.key])}
                  onChange={(next) => onChange({ ...value, [def.key]: next })}
                />
              </div>
            );
          }

          return (
            <div
              key={def.key}
              className="flex items-center gap-3 rounded-lg px-1 py-1.5"
            >
              {head}

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
                      className="w-24 rounded-lg border border-line bg-neutral-50 px-2 py-1.5 text-right text-base outline-none focus:border-accent/60 sm:text-sm dark:bg-white/5"
                    />
                  )}
                  {def.kind === "select" && (
                    <select
                      value={value[def.key] as string}
                      onChange={(e) =>
                        onChange({ ...value, [def.key]: e.target.value })
                      }
                      aria-label={def.label}
                      className="rounded-lg border border-line bg-neutral-50 px-2 py-1.5 text-base outline-none focus:border-accent/60 sm:text-sm dark:bg-white/5"
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
                      {...TERSE_INPUT}
                      className="w-36 rounded-lg border border-line bg-neutral-50 px-2 py-1.5 text-base outline-none focus:border-accent/60 sm:text-sm dark:bg-white/5"
                    />
                  )}
                  {toAuto}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setManual(def)}
                  aria-label={`${def.label}を手動設定`}
                  className="shrink-0 rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-neutral-200 dark:bg-white/10 dark:hover:bg-white/15"
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
