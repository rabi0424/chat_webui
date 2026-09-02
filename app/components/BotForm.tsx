import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router";
import type { BotRow } from "../lib/db.server";
import type { ModelInfo } from "../lib/openrouter.server";
import type { ShellContext } from "../routes/shell";
import { parseParamsJson, type ParamsState } from "../lib/params";
import { ModelPicker } from "./ModelPicker";
import { ParamsEditor } from "./ParamsEditor";
import { RetrySettings } from "./RetrySettings";
import { FIELD, FIELD_AREA, Group, Row } from "./controls";
import { PROSE_INPUT, TERSE_INPUT } from "../lib/ui";
import { useConfirm } from "./ConfirmDialog";
import { IconMenu } from "./icons";

export function BotForm({
  models,
  initial,
  retryCeiling,
  newModelDays,
}: {
  models: ModelInfo[];
  initial?: BotRow;
  /** アプリ全体の試行回数の天井（設定画面）。 */
  retryCeiling: number;
  /** モデル一覧で「NEW」を出す日数（設定画面）。 */
  newModelDays: number;
}) {
  const navigate = useNavigate();
  // シェルの外（テスト）でも描けるように、無ければドロワーの開閉だけ諦める
  const shell = useOutletContext<ShellContext | undefined>();
  const openSidebar = shell?.openSidebar;
  const confirm = useConfirm();
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
  /**
   * 「成功するまで生成」は成功の判定が「画像が返ったか」なので、
   * 会話の⚙パネルと同じく画像を出せるモデルのときだけ出す。
   */
  const canRetry = model?.outputModalities.includes("image") ?? false;

  async function resetParams() {
    const ok = await confirm({
      title: "生成パラメータを初期設定に戻しますか？",
      description: "すべて「自動」（モデル本来の既定値）に戻ります。",
      confirmLabel: "戻す",
    });
    if (!ok) return;
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
            method: "PATCH",
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

  const canSave = !!name.trim() && !!modelId && !saving;

  return (
    <div className="flex h-full flex-col">
      {/* 他の画面と同じ帯。以前はこの画面だけヘッダーが無く、ラベルの上が空いていた */}
      <header className="flex shrink-0 items-center gap-1 border-b border-black/[0.06] px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] dark:border-white/[0.06]">
        <div className="flex w-24 shrink-0 justify-start">
          {openSidebar && (
            <button
              type="button"
              onClick={openSidebar}
              aria-label="メニュー"
              className="rounded-lg p-2 text-ink-2 hover:bg-hover md:hidden"
            >
              <IconMenu className="h-5 w-5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => void navigate("/bots")}
            className="hidden whitespace-nowrap rounded-lg px-2 py-1.5 text-sm text-ink-2 hover:bg-hover md:block"
          >
            キャンセル
          </button>
        </div>
        <h1 className="font-display min-w-0 flex-1 truncate text-center text-[0.9375rem] font-bold tracking-tight">
          {initial ? "ボットを編集" : "新しいボット"}
        </h1>
        <div className="flex w-24 shrink-0 justify-end">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent/85 disabled:opacity-30"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-4 pb-[max(env(safe-area-inset-bottom),1.5rem)]">
          {error && (
            <p
              role="status"
              className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              {error}
            </p>
          )}

          <Group title="ボット">
            <Row label="名前" description="ホームのカードとツールバーに出ます" stack>
              <div className="flex w-full items-center gap-2">
                <input
                  type="text"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  aria-label="アイコン（絵文字）"
                  {...TERSE_INPUT}
                  className={`${FIELD} w-14 shrink-0 text-center text-xl`}
                />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="名前"
                  {...TERSE_INPUT}
                  placeholder="例: 翻訳者、コードレビュアー"
                  className={`${FIELD} min-w-0 flex-1`}
                />
              </div>
            </Row>
            <Row label="モデル" description="このボットで話すときに使うモデル">
              <ModelPicker
                models={models}
                value={modelId}
                newModelDays={newModelDays}
                onChange={setModelId}
                variant="field"
              />
            </Row>
            <Row
              label="システムプロンプト"
              description="このボットの役割・口調・制約などを書きます"
              stack
            >
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={8}
                aria-label="システムプロンプト"
                {...PROSE_INPUT}
                placeholder="このボットの役割・口調・制約などを書きます"
                className={FIELD_AREA}
              />
            </Row>
          </Group>

          {canRetry && (
            <Group title="生成のしかた">
              <div className="px-4 py-3">
                <RetrySettings
                  value={params}
                  onChange={setParams}
                  ceiling={retryCeiling}
                />
              </div>
            </Group>
          )}

          <Group
            title="生成パラメータ"
            note="このモデルが対応するものだけを出します。自動のままならモデル本来の既定に任せます。"
          >
            <Row label="パラメータ" stack>
              <div className="w-full">
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void resetParams()}
                    className="rounded-lg px-2 py-1 text-xs text-ink-2 hover:bg-hover"
                  >
                    初期設定に戻す
                  </button>
                </div>
                <ParamsEditor model={model} value={params} onChange={setParams} />
              </div>
            </Row>
          </Group>

          {/* iPhone ではヘッダーの「保存」が親指から遠いので、末尾にも置く */}
          <div className="flex justify-end gap-2 md:hidden">
            <button
              type="button"
              onClick={() => void navigate("/bots")}
              className="rounded-xl px-4 py-2.5 text-sm text-ink-2 hover:bg-hover"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canSave}
              className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg hover:bg-accent/85 disabled:opacity-30"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
