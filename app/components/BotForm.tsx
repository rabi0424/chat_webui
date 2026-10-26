import { useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router";
import type { BotDetailRow } from "../lib/db.server";
import type { ModelInfo } from "../lib/openrouter.server";
import type { ShellContext } from "../routes/shell";
import { parseParamsJson, type ParamsState } from "../lib/params";
import { ModelPicker } from "./ModelPicker";
import { ParamsEditor } from "./ParamsEditor";
import { RetrySettings } from "./RetrySettings";
import { FIELD, FIELD_AREA, Group, Row } from "./controls";
import { PROSE_INPUT, TERSE_INPUT } from "../lib/ui";
import { useConfirm } from "./ConfirmDialog";
import { IconMenu, IconPlus, IconX } from "./icons";
import {
  addBotFiles,
  BOT_FILES_MAX,
  BOT_FILES_TOTAL_CHARS,
  parseBotFiles,
  totalChars,
  type BotFile,
} from "../lib/bot-files";
import { isTextFile, readTextFile, TEXT_FILE_ACCEPT } from "../lib/text-file";

export function BotForm({
  models,
  initial,
  retryCeiling,
  newModelDays,
  fileMaxChars,
  fileMaxBytes,
}: {
  models: ModelInfo[];
  initial?: BotDetailRow;
  /** アプリ全体の試行回数の天井（設定画面）。 */
  retryCeiling: number;
  /** モデル一覧で「NEW」を出す日数（設定画面）。 */
  newModelDays: number;
  /**
   * 添付ファイル1本の上限（字数・バイト）。入力欄のテキストファイルと
   * 同じ値（設定画面の「リンクの取り込み」）——同じファイルが入力欄
   * からは全部入り、ボットには一部しか入らない、という食い違いを作らない。
   */
  fileMaxChars: number;
  fileMaxBytes: number;
}) {
  const navigate = useNavigate();
  // シェルの外（テスト）でも描けるように、無ければドロワーの開閉だけ諦める
  const shell = useOutletContext<ShellContext | undefined>();
  const openSidebar = shell?.openSidebar;
  const confirm = useConfirm();
  const [name, setName] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "🤖");
  const [chosenModelId, setModelId] = useState(initial?.model_id ?? "");
  /*
   * モデル一覧はシェルが遅れて読む。起動直後にこの画面を開くと、
   * 最初の描画では一覧が空。「選んでいなければ先頭」を state に写すと
   * 空のまま固定され、保存が理由なく押せなかった（監査 P-5）。
   * 選択は state に持ち、既定は描画のたびに一覧から引く
   */
  const modelId = chosenModelId || models[0]?.id || "";
  const [systemPrompt, setSystemPrompt] = useState(
    initial?.system_prompt ?? "",
  );
  const [params, setParams] = useState<ParamsState>(() =>
    parseParamsJson(initial?.params_json),
  );
  const [files, setFiles] = useState<BotFile[]>(() =>
    parseBotFiles(initial?.files_json),
  );
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  /**
   * ファイルを読んで足す。入力欄のテキストファイルと同じ読み方
   * （文字コードの見分け・`.html` の本文の取り出し・大きさの上限）を通す。
   *
   * 読めなかったものは足さずに知らせる。空の囲みを渡すと、モデルは
   * 「中身の無いファイル」を読んだことにして答えてしまう。
   */
  async function addFiles(list: File[]) {
    setFileNotice(null);
    const { extractPage } = await import("../lib/page-extract.client");
    const read: BotFile[] = [];
    const notText: string[] = [];
    const empty: string[] = [];
    for (const file of list) {
      if (!isTextFile(file)) {
        notText.push(file.name);
        continue;
      }
      let got;
      try {
        got = await readTextFile(file, fileMaxBytes);
      } catch {
        empty.push(file.name);
        continue;
      }
      const page = extractPage(
        { url: "", contentType: got.contentType, body: got.body },
        fileMaxChars,
      );
      if (page.text.trim() === "") {
        empty.push(file.name);
        continue;
      }
      read.push({
        name: got.name,
        content: page.text,
        ...(got.truncated || page.truncated ? { truncated: true } : {}),
      });
    }
    const added = addBotFiles(files, read);
    setFiles(added.files);
    const notes = [
      notText.length > 0 &&
        `テキストとして読めるファイルだけを付けられます: ${notText.join("、")}`,
      empty.length > 0 && `中身を読み取れませんでした: ${empty.join("、")}`,
      added.rejected.length > 0 &&
        `上限（${BOT_FILES_MAX}件・合計${BOT_FILES_TOTAL_CHARS.toLocaleString()}字）を超えるため付けられませんでした: ${added.rejected.join("、")}`,
    ].filter((x): x is string => typeof x === "string");
    setFileNotice(notes.length > 0 ? notes.join("\n") : null);
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
        files,
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
      <header className="flex shrink-0 items-center gap-1 border-b border-line px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
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
        <h1 className="min-w-0 flex-1 truncate text-center text-[0.9375rem] font-semibold">
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

          <Group
            title="ファイル"
            note="テキストとして読めるファイル（.txt .md .csv .json .py など）を参照用の資料として付けます。中身はシステムプロンプトの後ろに入り、毎回の送信でモデルへ渡ります（そのぶん入力の額がかかります）。会話には始めたときのファイルが写し取られます。"
          >
            <div
              className="px-4 py-3"
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("Files")) e.preventDefault();
              }}
              onDrop={(e) => {
                const dropped = Array.from(e.dataTransfer.files);
                if (dropped.length === 0) return;
                e.preventDefault();
                void addFiles(dropped);
              }}
            >
              {files.length > 0 && (
                <ul className="mb-2 divide-y divide-black/[0.06] dark:divide-white/[0.08]">
                  {files.map((f) => (
                    <li key={f.name} className="flex items-center gap-2 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{f.name}</p>
                        <p className="text-xs text-ink-2">
                          {f.content.length.toLocaleString()}字
                          {f.truncated && "・一部"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setFiles(files.filter((x) => x.name !== f.name))
                        }
                        aria-label={`${f.name} を外す`}
                        className="shrink-0 rounded-lg p-2 text-ink-2 hover:bg-hover"
                      >
                        <IconX className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-accent-ink hover:bg-hover"
                >
                  <IconPlus className="h-4 w-4" />
                  ファイルを追加
                </button>
                {files.length > 0 && (
                  <p className="text-xs text-ink-2">
                    {files.length}件・合計{totalChars(files).toLocaleString()}字
                  </p>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={TEXT_FILE_ACCEPT.join(",")}
                aria-label="ボットに付けるファイル"
                className="hidden"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  // 同じファイルを選び直しても change が来るように空ける
                  e.target.value = "";
                  if (picked.length > 0) void addFiles(picked);
                }}
              />
              {fileNotice && (
                <p
                  role="status"
                  className="mt-2 whitespace-pre-line text-xs text-red-700 dark:text-red-300"
                >
                  {fileNotice}
                </p>
              )}
            </div>
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
