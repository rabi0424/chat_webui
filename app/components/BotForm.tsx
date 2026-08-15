import { useState } from "react";
import { useNavigate } from "react-router";
import type { BotRow } from "../lib/db.server";
import type { ModelInfo } from "../lib/openrouter.server";
import { parseParamsJson, type ParamsState } from "../lib/params";
import { ModelPicker } from "./ModelPicker";
import { ParamsEditor } from "./ParamsEditor";

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
  const [params, setParams] = useState<ParamsState>(() =>
    parseParamsJson(initial?.params_json),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const model = models.find((m) => m.id === modelId);

  function resetParams() {
    if (
      !confirm(
        "生成パラメータを初期設定（すべて自動 = モデル既定値）に戻します。よろしいですか？",
      )
    ) {
      return;
    }
    setParams({});
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
        params: Object.keys(params).length > 0 ? params : null,
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
    <div className="mx-auto max-w-2xl space-y-6 px-4 pb-6 pt-[calc(1.5rem+env(safe-area-inset-top))]">
      <div className="flex items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
            アイコン（絵文字）
          </label>
          <input
            type="text"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            aria-label="アイコン（絵文字）"
            className="w-16 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-center text-xl outline-none focus:border-accent/60 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
            名前 *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="名前"
            placeholder="例: 翻訳者、コードレビュアー"
            className="w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 outline-none placeholder:text-neutral-400 focus:border-accent/60 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
          モデル *
        </label>
        <div className="rounded-xl border border-neutral-200 p-1 dark:border-neutral-700">
          <ModelPicker models={models} value={modelId} onChange={setModelId} />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">
          システムプロンプト
        </label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={8}
          aria-label="システムプロンプト"
          placeholder="このボットの役割・口調・制約などを書きます"
          className="w-full resize-y rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 outline-none placeholder:text-neutral-400 focus:border-accent/60 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            生成パラメータ（このモデルが対応するもの）
          </span>
          <button
            type="button"
            onClick={resetParams}
            className="rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            初期設定に戻す
          </button>
        </div>
        <ParamsEditor model={model} value={params} onChange={setParams} />
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
          className="rounded-xl px-4 py-2.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!name.trim() || !modelId || saving}
          className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg hover:bg-accent/85 disabled:opacity-30"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}
