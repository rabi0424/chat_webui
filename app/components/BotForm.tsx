import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { BotRow } from "../lib/db.server";
import type { ModelInfo } from "../lib/openrouter.server";
import { defaultParams, paramsForModel } from "../lib/params";
import { ModelPicker } from "./ModelPicker";

export function BotForm({
  models,
  initial,
}: {
  models: ModelInfo[];
  initial?: BotRow;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "🤖");
  const [modelId, setModelId] = useState(
    initial?.model_id ?? models[0]?.id ?? "",
  );
  const [systemPrompt, setSystemPrompt] = useState(
    initial?.system_prompt ?? "",
  );
  const model = models.find((m) => m.id === modelId);
  const paramDefs = useMemo(
    () => paramsForModel(model?.supportedParameters ?? []),
    [model],
  );
  const [params, setParams] = useState<Record<string, number>>(() => {
    const base = defaultParams(model?.supportedParameters ?? []);
    if (initial?.params_json) {
      try {
        return { ...base, ...JSON.parse(initial.params_json) };
      } catch {
        return base;
      }
    }
    return base;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeModel(id: string) {
    setModelId(id);
    const supported = models.find((m) => m.id === id)?.supportedParameters ?? [];
    // 新モデルで対応するパラメータ: 既存の値は引き継ぎ、新規は既定値で埋める
    setParams((prev) => {
      const next = defaultParams(supported);
      for (const key of Object.keys(next)) {
        if (key in prev) next[key] = prev[key];
      }
      return next;
    });
  }

  function resetParams() {
    if (!confirm("生成パラメータを初期設定に戻します。よろしいですか？")) return;
    setParams(defaultParams(model?.supportedParameters ?? []));
  }

  async function save() {
    if (!name.trim() || !modelId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({
        name,
        icon: icon.trim() || "🤖",
        modelId,
        systemPrompt,
        params,
      });
      const res = initial
        ? await fetch(`/api/bots/${initial.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body,
          })
        : await fetch("/api/bots", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(data?.error ?? "保存に失敗しました");
      }
      await navigate("/bots");
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <div className="flex items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
            アイコン（絵文字）
          </label>
          <input
            type="text"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            aria-label="アイコン（絵文字）"
            className="w-16 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-center text-xl outline-none focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-900"
          />
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
            名前 *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="名前"
            placeholder="例: 翻訳者、コードレビュアー"
            className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 outline-none placeholder:text-gray-400 focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-900"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
          モデル *
        </label>
        <div className="rounded-xl border border-gray-200 p-1 dark:border-gray-700">
          <ModelPicker models={models} value={modelId} onChange={changeModel} />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
          システムプロンプト
        </label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={8}
          aria-label="システムプロンプト"
          placeholder="このボットの役割・口調・制約などを書きます"
          className="w-full resize-y rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 outline-none placeholder:text-gray-400 focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-900"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
            生成パラメータ（このモデルが対応するもの）
          </span>
          <button
            type="button"
            onClick={resetParams}
            className="rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            初期設定に戻す
          </button>
        </div>
        {paramDefs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-200 px-4 py-3 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
            このモデルの対応パラメータ情報がありません
          </p>
        ) : (
          <div className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
            {paramDefs.map((def) => (
              <div key={def.key} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{def.label}</p>
                  <p className="truncate text-xs text-gray-400 dark:text-gray-500">
                    {def.description}（既定: {def.defaultValue}）
                  </p>
                </div>
                <input
                  type="number"
                  value={params[def.key] ?? def.defaultValue}
                  min={def.min}
                  max={def.max}
                  step={def.step}
                  onChange={(e) =>
                    setParams((prev) => ({
                      ...prev,
                      [def.key]: Number(e.target.value),
                    }))
                  }
                  aria-label={def.label}
                  className="w-24 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-right text-sm outline-none focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-900"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => void navigate("/bots")}
          className="rounded-xl px-4 py-2.5 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!name.trim() || !modelId || saving}
          className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-30"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}
