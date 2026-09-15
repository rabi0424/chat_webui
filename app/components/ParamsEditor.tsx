import { useState } from "react";
import type { ModelInfo } from "../lib/openrouter.server";
import { TERSE_INPUT } from "../lib/ui";
import { isShapeChoice } from "../lib/aspect";
import { ShapePicker, ShapePreview } from "./ShapePicker";
import {
  inputScaleOf,
  paramsForModel,
  resolveScaledSize,
  scalesFromInput,
  POE_EXTRA_KEY_PATTERN,
  POE_EXTRA_PREFIX,
  SIZE_FROM_INPUT_KEY,
  SIZE_SCALE_CHOICES,
  SIZE_SCALE_KEY,
  type ParamDef,
  type ParamsState,
} from "../lib/params";
import type { ImageSize } from "../lib/image-size";
import { adjustmentText, megapixelText, sizeText } from "../lib/output-size";

/** ⚙から見た入力欄の添付（順番はそのまま。1枚目が倍率の相手）。 */
export interface InputImage {
  imageSize?: ImageSize;
}

/** オン/オフのつまみ（Web検索のトグルと同じ形）。 */
function Switch({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        on ? "bg-accent" : "bg-neutral-300 dark:bg-neutral-600"
      }`}
    >
      <span
        className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

/**
 * 「入力画像に合わせる」がオンのときの、倍率と出来上がりの大きさ。
 *
 * ここに出す大きさは、実際に送る値と**同じ関数**（resolveScaledSize）から
 * 出す。別々に計算すると、画面は 2048×2048 と言っているのに違う大きさで
 * 作られることになり、絵が出てしまう以上そのまま気づけない。
 *
 * MP を併記するのは、予期せず巨大な絵を作らせないため。倍率は入力画像に
 * 掛かるので、同じ「2倍」でも入力次第で1MPにも30MPにもなる——額と時間は
 * そちらに比例する。
 */
function InputScaleRow({
  provider,
  value,
  onChange,
  inputImages,
}: {
  provider: "apiyi" | "runware";
  value: ParamsState;
  onChange: (next: ParamsState) => void;
  inputImages: readonly InputImage[];
}) {
  const scale = inputScaleOf(value);
  const input = inputImages[0]?.imageSize;
  const resolved = resolveScaledSize(value, provider, input);
  // 保存済みの設定に段以外の値が残っていることがある（ボットの初期設定や、
  // 範囲の変更のあと）。黙って別の段に見せないよう、その値も並べる
  const choices = [...new Set([...SIZE_SCALE_CHOICES, scale])].sort(
    (a, b) => a - b,
  );

  return (
    <div className="mt-2 space-y-2 rounded-lg bg-neutral-50 px-2.5 py-2 dark:bg-white/5">
      <div className="flex items-center gap-3">
        <label className="flex-1 text-xs text-ink-2" htmlFor="size-scale">
          倍率
        </label>
        {/*
          自由入力にしない。打っている途中の値（"1" → "13"）がそのまま
          倍率として効いてしまい、消したときに何倍なのかも言えなくなる。
          決まった段だけにすれば、打ち間違いで桁が変わることも無い。
        */}
        <select
          id="size-scale"
          value={String(scale)}
          onChange={(e) =>
            onChange({ ...value, [SIZE_SCALE_KEY]: Number(e.target.value) })
          }
          className="rounded-lg border border-line bg-white px-2 py-1.5 text-base outline-none focus:border-accent/60 sm:text-sm dark:bg-white/5"
        >
          {choices.map((v) => (
            <option key={v} value={String(v)}>
              ×{v}
            </option>
          ))}
        </select>
      </div>
      {inputImages.length === 0 ? (
        /* ボットの編集画面にも同じ⚙が出る（入力欄はまだ無い）ので、
           「いま画像が無い」ではなく「あるときだけ効く」と言う */
        <p className="text-xs text-ink-3">
          入力欄に画像があるときだけ効きます（無ければ上の「サイズ」で作られます）
        </p>
      ) : !input || !resolved ? (
        <p className="text-xs text-ink-3">
          入力画像の大きさを読み取れませんでした。このまま送ると上の「サイズ」で作られます
        </p>
      ) : (
        <p className="text-xs text-ink-2">
          入力 {sizeText(input)}（{megapixelText(input)}）× {scale} →{" "}
          <span className="font-medium tabular-nums">
            {sizeText(resolved.size)}
          </span>
          （{megapixelText(resolved.size)}）
          {inputImages.length > 1 ? "（1枚目を基準）" : ""}
        </p>
      )}
      {resolved && adjustmentText(resolved.adjustment) && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {adjustmentText(resolved.adjustment)}
        </p>
      )}
    </div>
  );
}

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
  inputImages = [],
}: {
  model: ModelInfo | undefined;
  value: ParamsState;
  onChange: (next: ParamsState) => void;
  /**
   * 入力欄にいま並んでいる画像。「入力画像に合わせる」の見積もりに使う
   * （渡さなければ、画像が無いものとして扱う）。
   */
  inputImages?: readonly InputImage[];
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
          /*
           * 倍率は「入力画像に合わせる」の中に置く。オフのときに単体で
           * 並んでいても、何に掛かる数字なのか読めない。
           */
          if (def.key === SIZE_SCALE_KEY) return null;
          const manual = value[def.key] != null;
          /*
           * 形（アスペクト比・解像度）の選択肢は <select> にしない。
           * "1536x1024" と "1024x1536" は並べても見分けが付かず、
           * 縦長・横長は形を描いて初めて分かる。
           */
          const shapes =
            def.kind === "select" &&
            isShapeChoice(def.options.map((o) => o.value));
          /*
           * 「入力画像に合わせる」がオンのあいだ、固定のサイズは送られない。
           * 選んだ値がそのまま残って見えるので、効いていないことを
           * 説明に出す（黙って無視されると、選び直しても何も変わらない）。
           */
          const superseded = def.key === "size" && scalesFromInput(value);
          const head = (
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{def.label}</p>
              <p className="truncate text-xs text-ink-3">
                {superseded
                  ? "「入力画像に合わせる」がオンのあいだは使いません"
                  : def.description}
              </p>
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

          if (def.kind === "toggle") {
            const on = value[def.key] === "on";
            return (
              <div key={def.key} className="rounded-lg px-1 py-1.5">
                <div className="flex items-center gap-3">
                  {head}
                  <Switch
                    on={on}
                    label={def.label}
                    onChange={(next) => {
                      const state = { ...value };
                      if (next) state[def.key] = "on";
                      else delete state[def.key];
                      onChange(state);
                    }}
                  />
                </div>
                {on && def.key === SIZE_FROM_INPUT_KEY && (
                  <InputScaleRow
                    provider={model.provider === "runware" ? "runware" : "apiyi"}
                    value={value}
                    onChange={onChange}
                    inputImages={inputImages}
                  />
                )}
              </div>
            );
          }

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
