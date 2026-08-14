import type { ModelInfo } from "../lib/openrouter.server";
import {
  paramsForModel,
  type ParamDef,
  type ParamsState,
} from "../lib/params";

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
  const defs = paramsForModel(model?.supportedParameters ?? []);

  function setManual(def: ParamDef) {
    const initial =
      def.kind === "number"
        ? def.key === "max_tokens"
          ? Math.min(4096, def.max)
          : def.key === "temperature" || def.key === "top_p" || def.key === "repetition_penalty"
            ? 1
            : def.min
        : def.kind === "select"
          ? def.options[def.options.length - 1].value
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
      <p className="rounded-xl border border-dashed border-gray-200 px-4 py-3 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
        モデルを選択するとパラメータが表示されます
      </p>
    );
  }
  if (defs.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-gray-200 px-4 py-3 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
        このモデルの対応パラメータ情報がありません
      </p>
    );
  }

  return (
    <div className="space-y-1 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
      <p className="px-1 pb-1 text-xs text-gray-400 dark:text-gray-500">
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
              <p className="truncate text-xs text-gray-400 dark:text-gray-500">
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
                    className="w-24 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-right text-base outline-none focus:border-indigo-400 sm:text-sm dark:border-gray-700 dark:bg-gray-900"
                  />
                )}
                {def.kind === "select" && (
                  <select
                    value={value[def.key] as string}
                    onChange={(e) =>
                      onChange({ ...value, [def.key]: e.target.value })
                    }
                    aria-label={def.label}
                    className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-base outline-none focus:border-indigo-400 sm:text-sm dark:border-gray-700 dark:bg-gray-900"
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
                    className="w-36 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-base outline-none focus:border-indigo-400 sm:text-sm dark:border-gray-700 dark:bg-gray-900"
                  />
                )}
                <button
                  type="button"
                  onClick={() => setAuto(def.key)}
                  aria-label={`${def.label}を自動に戻す`}
                  className="shrink-0 rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
                >
                  自動に戻す
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setManual(def)}
                aria-label={`${def.label}を手動設定`}
                className="shrink-0 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
              >
                自動
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
