import { startTransition, useEffect, useState } from "react";
import { useCopied } from "../lib/use-copied";
import { useOutletContext, useRevalidator } from "react-router";
import type { Route } from "./+types/settings";
import type { ShellContext } from "./shell";
import { getAppSettings } from "../lib/db.server";
import {
  DEFAULT_SYSTEM_PROMPT_MAX,
  MONTHLY_LIMIT_RANGE,
  NEW_MODEL_DAYS_RANGE,
  POE_RATE_RANGE,
  RETRY_CEILING_RANGE,
  type AppSettings,
} from "../lib/settings";
import { monthLabelJst } from "../lib/usage";
import { saveTheme, useTheme, type Theme } from "../lib/theme";
import {
  CHAT_FONT_SIZES,
  saveChatFontSize,
  useChatFontSize,
} from "../lib/chat-font";
import { AccentPicker } from "../components/ThemeToggle";
import { NumberInput } from "../components/NumberInput";
import { ModelPicker } from "../components/ModelPicker";
import { ParamsEditor } from "../components/ParamsEditor";
import { DEFAULT_MODEL } from "../lib/constants";
import { clearLastUsedModel, useLastUsedModel } from "../lib/persisted";
import { PROSE_INPUT } from "../lib/ui";
import type { ParamsState } from "../lib/params";
import { IconCheck, IconCopy, IconMenu, IconTrash } from "../components/icons";
import { useConfirm } from "../components/ConfirmDialog";
import {
  clearSamples,
  compareLatest,
  currentBuildId,
  delta,
  formatComparison,
  loadSamples,
  type BuildComparison,
} from "../lib/perf";

export function meta() {
  return [{ title: "設定 - Chat WebUI" }];
}

export async function loader() {
  // 「今月」の判定に使う。描画のたびに時計を読むと結果が揺れるため
  return { settings: await getAppSettings(), now: Date.now() };
}

/**
 * 設定はめったに変わらないので短時間メモリに持ち、再訪を即表示にする。
 * 保存時は save() が新しい値で上書きするため、古い値へ戻ることはない。
 */
let settingsCache: { at: number; data: { settings: AppSettings } } | null =
  null;
const SETTINGS_TTL_MS = 5 * 60 * 1000;

export async function clientLoader({
  serverLoader,
}: Route.ClientLoaderArgs) {
  // 使い回すのは設定だけ。「今月」は読み込みのたびに作り直す
  // （5分のキャッシュが月をまたぐと、一時解除の対象月がずれる）
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) {
    return { ...settingsCache.data, now: Date.now() };
  }
  const data = await serverLoader();
  settingsCache = { at: Date.now(), data: { settings: data.settings } };
  return data;
}

const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
  { value: "system", label: "自動" },
];

/** 設定の1項目。見出し・説明・操作を横並びにする。 */
function Row({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-1 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          {description}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {title}
      </h2>
      <div className="rounded-2xl border border-neutral-200/80 p-3 dark:border-white/10">
        {children}
      </div>
      {note && (
        <p className="mt-1.5 px-1 text-xs text-neutral-400 dark:text-neutral-500">
          {note}
        </p>
      )}
    </section>
  );
}

/** 前回ビルド比の表示。速くなったら緑、遅くなったら赤。 */
function DeltaBadge({ cur, prev }: { cur: number; prev: number | undefined }) {
  const d = delta(cur, prev);
  if (!d) {
    return (
      <span className="block text-[10px] text-neutral-300 dark:text-neutral-600">
        —
      </span>
    );
  }
  const sign = d.ms > 0 ? "+" : "";
  return (
    <span
      className={`block text-[10px] tabular-nums ${
        d.ms < 0
          ? "text-emerald-600 dark:text-emerald-400"
          : d.ms > 0
            ? "text-red-600 dark:text-red-400"
            : "text-neutral-400 dark:text-neutral-500"
      }`}
    >
      {sign}
      {d.ms}ms / {sign}
      {d.pct}%
    </span>
  );
}

/**
 * ページ遷移の実測の集計（lib/perf.ts）。表示は常に「現行ビルド」で、
 * デプロイするとビルドIDが変わって自動で新しい集計に切り替わる。
 * 各項目には直前のビルドとの差（絶対値と割合）を添える。
 */
function PerfPanel() {
  const [comparison, setComparison] = useState<BuildComparison | null>(null);
  const [copied, flashCopied] = useCopied();
  const confirm = useConfirm();

  // localStorageはSSRで読めないので描画後に読む。集計は画面表示を
  // 待たせないよう低優先度で行う
  useEffect(() => {
    startTransition(() => setComparison(compareLatest(loadSamples())));
  }, []);

  const copy = async () => {
    if (!comparison) return;
    try {
      await navigator.clipboard.writeText(formatComparison(comparison));
      flashCopied();
    } catch {
      // 権限がない環境では黙って何もしない
    }
  };

  if (!comparison || (!comparison.current && !comparison.previous)) {
    return (
      <p className="px-1 py-2 text-sm text-neutral-400 dark:text-neutral-500">
        まだ記録がありません。ページを行き来すると自動で貯まります。
      </p>
    );
  }

  const { current, previous } = comparison;

  return (
    <div className="space-y-3">
      <p className="px-1 text-xs font-medium text-neutral-400 dark:text-neutral-500">
        現行ビルド {currentBuildId()}
        {current && (
          <>
            {" "}
            ・ {current.total}件 ・ 最終{" "}
            {new Date(current.lastAt).toLocaleDateString("ja-JP")}
          </>
        )}
        {previous && (
          <>
            <br />
            前回ビルド {previous.build}（{previous.total}件）との比較
          </>
        )}
      </p>
      {!current ? (
        <p className="px-1 text-sm text-neutral-400 dark:text-neutral-500">
          このビルドの記録はまだありません。ページを行き来すると貯まります。
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-400 dark:text-neutral-500">
              <th className="px-1 py-0.5 font-normal">ページ</th>
              <th className="px-1 py-0.5 text-right font-normal">回数</th>
              <th className="px-1 py-0.5 text-right font-normal">中央値</th>
              <th className="px-1 py-0.5 text-right font-normal">p90</th>
            </tr>
          </thead>
          <tbody className="align-top">
            {current.routes.map((r) => {
              const prev = previous?.routes.find((p) => p.path === r.path);
              return (
                <tr key={r.path}>
                  <td className="truncate px-1 py-1 font-mono text-xs">
                    {r.path}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums">
                    {r.count}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums">
                    {r.median}ms
                    <DeltaBadge cur={r.median} prev={prev?.median} />
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums">
                    {r.p90}ms
                    <DeltaBadge cur={r.p90} prev={prev?.p90} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void copy()}
          className="flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
        >
          {copied ? (
            <IconCheck className="h-4 w-4" />
          ) : (
            <IconCopy className="h-4 w-4" />
          )}
          {copied ? "コピーしました" : "結果をコピー"}
        </button>
        <button
          type="button"
          onClick={async () => {
            const ok = await confirm({
              title: "遷移の記録をすべて消しますか？",
              confirmLabel: "消去",
              destructive: true,
            });
            if (!ok) return;
            clearSamples();
            setComparison(compareLatest([]));
          }}
          aria-label="記録を消去"
          title="記録を消去"
          className="rounded-lg border border-neutral-200 p-1.5 text-neutral-400 hover:bg-neutral-50 hover:text-neutral-600 dark:border-white/10 dark:hover:bg-white/5 dark:hover:text-neutral-300"
        >
          <IconTrash className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const { openSidebar, models } = useOutletContext<ShellContext>();
  const revalidator = useRevalidator();
  const [settings, setSettings] = useState<AppSettings>(loaderData.settings);
  /** 一時解除の対象月。ローダーの時刻から作る（描画のたびに変わらない）。 */
  const thisMonth = monthLabelJst(loaderData.now);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 端末ごとの設定は localStorage。保存値を購読するので、
  // サイドバーのトグルで変えた分もここに出る（SSRでは既定値）
  const theme = useTheme();
  const chatFont = useChatFontSize();

  /*
   * この端末で最後に使ったモデル。設定の既定より優先されるので、
   * いま効いている値としてここに出す。
   */
  const lastUsedModel = useLastUsedModel();

  async function save(patch: Partial<AppSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json()) as { settings?: AppSettings };
      if (!res.ok || !body.settings) throw new Error();
      // 範囲外の値はサーバー側で丸められるので、戻り値で上書きする
      setSettings(body.settings);
      settingsCache = { at: Date.now(), data: { settings: body.settings } };
      // シェル経由でChatが参照する設定も更新する（遷移では再読込しないため）
      revalidator.revalidate();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      setError("設定を保存できませんでした");
      setSettings(settings);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-neutral-100 px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] dark:border-neutral-800">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="メニュー"
          className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 md:hidden dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <IconMenu className="h-5 w-5" />
        </button>
        <h1 className="px-1 text-sm font-semibold tracking-tight">設定</h1>
        {saved && (
          <span className="ml-2 text-xs text-neutral-400 dark:text-neutral-500">
            保存しました
          </span>
        )}
        {error && (
          <span className="ml-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
          <Section
            title="新規チャットの既定"
            note="ここで決めた内容は、会話を作った時点で写し取られます。あとで変えても、既にある会話は変わりません。ボットを選んで始めたときは、ボットの設定が優先されます。"
          >
            <Row
              label="既定のモデル"
              description="新しいチャットで最初に選ばれるモデル"
            >
              <div className="w-56 rounded-xl border border-neutral-200 p-1 dark:border-neutral-700">
                <ModelPicker
                  models={models}
                  value={settings.defaultModelId ?? DEFAULT_MODEL}
                  newModelDays={settings.newModelDays}
                  onChange={(id) => void save({ defaultModelId: id })}
                />
              </div>
            </Row>
            {settings.defaultModelId !== null &&
              models.length > 0 &&
              !models.some((m) => m.id === settings.defaultModelId) && (
                /*
                 * 指定したモデルが一覧から消えた（提供終了・名前変更）。
                 * 黙って別のモデルで始めると、意図と違う額がかかる
                 */
                <p className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  「{settings.defaultModelId}
                  」はいまのモデル一覧にありません。新しいチャットは一覧の先頭のモデルで始まります。
                </p>
              )}
            {lastUsedModel !== null && lastUsedModel !== settings.defaultModelId && (
              /*
               * この端末では「最後に使ったモデル」が優先される。設定を
               * 変えても画面が変わらないと壊れて見えるので、いま効いて
               * いる値と、戻す手立てをここに出す
               */
              <div className="mt-1 flex items-center justify-between gap-3 rounded-lg bg-neutral-100 px-3 py-2 text-xs dark:bg-white/5">
                <span className="min-w-0">
                  この端末では、最後に使った「
                  {models.find((m) => m.id === lastUsedModel)?.name ??
                    lastUsedModel}
                  」が優先されます。
                </span>
                <button
                  type="button"
                  onClick={() => clearLastUsedModel()}
                  className="shrink-0 rounded-lg border border-neutral-300 px-2 py-1 hover:bg-neutral-200 dark:border-white/20 dark:hover:bg-white/10"
                >
                  この端末の記憶を消す
                </button>
              </div>
            )}

            <Row
              label="システムプロンプト"
              description="ボットを使わないチャットに入れる指示。空なら入れません"
            >
              <span className="text-xs text-neutral-400">
                {settings.defaultSystemPrompt.length} / {DEFAULT_SYSTEM_PROMPT_MAX}
              </span>
            </Row>
            <textarea
              value={settings.defaultSystemPrompt}
              onChange={(e) =>
                void save({
                  defaultSystemPrompt: e.target.value.slice(
                    0,
                    DEFAULT_SYSTEM_PROMPT_MAX,
                  ),
                })
              }
              rows={4}
              aria-label="既定のシステムプロンプト"
              placeholder="例: 回答は日本語で、結論から先に書いてください。"
              {...PROSE_INPUT}
              className="mb-2 w-full resize-y rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-base outline-none placeholder:text-neutral-400 focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
            />

            <Row
              label="生成パラメータ"
              description="ボットを使わないチャットの初期値。自動のままならモデル本来の既定に任せます"
            >
              <span />
            </Row>
            <ParamsEditor
              model={models.find(
                (m) => m.id === (settings.defaultModelId ?? DEFAULT_MODEL),
              )}
              value={settings.defaultParams as ParamsState}
              onChange={(v) => void save({ defaultParams: v })}
            />
          </Section>

          <Section
            title="生成"
            note="上流のAPIに繰り返し要求を出す機能の歯止め。会話ごとの設定はこの値を超えられません。"
          >
            <Row
              label="リトライの上限回数"
              description={`1回の依頼で許可する最大試行回数（${RETRY_CEILING_RANGE.min}〜${RETRY_CEILING_RANGE.max}）`}
            >
              <NumberInput
                label="リトライの上限回数"
                value={settings.retryAttemptCeiling}
                min={RETRY_CEILING_RANGE.min}
                max={RETRY_CEILING_RANGE.max}
                step={1}
                onChange={(v) => void save({ retryAttemptCeiling: v })}
                className="w-24 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-right text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
              />
            </Row>
          </Section>

          <Section
            title="コスト"
            note="使った額は「使用量」で見られます。会話を消しても記録は残るので、消すことで上限が緩むことはありません。"
          >
            <Row
              label="月間の上限"
              description={`超えると生成を止めます（0 で上限なし・JSTの暦月・最大${MONTHLY_LIMIT_RANGE.max.toLocaleString()}円）`}
            >
              <NumberInput
                label="月間の上限"
                value={settings.monthlyLimitJpy}
                min={MONTHLY_LIMIT_RANGE.min}
                max={MONTHLY_LIMIT_RANGE.max}
                step={100}
                onChange={(v) => void save({ monthlyLimitJpy: v })}
                className="w-28 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-right text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
              />
            </Row>
            {settings.monthlyLimitJpy > 0 && (
              <Row
                label="今月だけ上限を解除"
                description="翌月には自動で戻ります（解除したまま忘れないため、恒久の設定にはしていません）"
              >
                <input
                  type="checkbox"
                  aria-label="今月だけ上限を解除"
                  checked={
                    settings.monthlyLimitOverride === thisMonth
                  }
                  onChange={(e) =>
                    void save({
                      monthlyLimitOverride: e.target.checked
                        ? thisMonth
                        : null,
                    })
                  }
                  className="h-5 w-5 accent-[var(--accent)]"
                />
              </Row>
            )}
            <Row
              label="Poe のポイント換算"
              description="1ポイントあたりのドル。Poe が額を返さなかった分を上限の計算に入れます（0 で入れない）"
            >
              <NumberInput
                label="Poe のポイント換算"
                value={settings.poePointsUsdRate}
                min={POE_RATE_RANGE.min}
                max={POE_RATE_RANGE.max}
                step={0.0001}
                onChange={(v) => void save({ poePointsUsdRate: v })}
                className="w-28 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-right text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
              />
            </Row>
          </Section>

          <Section
            title="モデル一覧"
            note="公開日はモデル一覧APIが申告する値。日付を返さないモデルには印を付けません。"
          >
            <Row
              label="新着として出す日数"
              description={`公開からこの日数だけ NEW を表示（0 で表示しない・最大${NEW_MODEL_DAYS_RANGE.max}）`}
            >
              <NumberInput
                label="新着として出す日数"
                value={settings.newModelDays}
                min={NEW_MODEL_DAYS_RANGE.min}
                max={NEW_MODEL_DAYS_RANGE.max}
                step={1}
                onChange={(v) => void save({ newModelDays: v })}
                className="w-24 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-right text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
              />
            </Row>
          </Section>

          <Section title="外観" note="この端末にのみ適用されます。">
            <Row label="テーマ" description="ライト / ダーク / 端末設定に追従">
              <select
                value={theme}
                onChange={(e) => saveTheme(e.target.value as Theme)}
                aria-label="テーマ"
                className="rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-base outline-none focus:border-accent/60 sm:text-sm dark:border-white/10 dark:bg-white/5"
              >
                {THEMES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="アクセント色" description="ボタンや強調表示の色">
              <AccentPicker />
            </Row>
            <Row
              label="チャットの文字サイズ"
              description="会話画面の本文と入力欄の大きさ"
            >
              <div className="flex overflow-hidden rounded-lg border border-neutral-200 dark:border-white/10">
                {CHAT_FONT_SIZES.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    aria-pressed={chatFont === f.value}
                    onClick={() => saveChatFontSize(f.value)}
                    className={`px-3 py-1.5 text-sm transition-colors ${
                      chatFont === f.value
                        ? "bg-accent text-accent-fg"
                        : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/5"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </Row>
            <p className="px-1 pb-1 text-xs text-neutral-400 dark:text-neutral-500">
              <span
                className="chat-text"
                style={{ display: "inline-block", lineHeight: 1.6 }}
              >
                この大きさで表示されます。
              </span>
            </p>
          </Section>

          <Section
            title="パフォーマンス"
            note="ページ遷移のたびに自動で記録されます（この端末のみ・最大1000件）。デプロイすると現行ビルドの集計に切り替わり、各数値に前回ビルドとの差が付きます。"
          >
            <PerfPanel />
          </Section>
        </div>
      </div>
    </div>
  );
}


// 例外の受け皿はこのルートに置く。root に任せると文書ごと
// 差し替わり、サイドバーまで消えて戻る導線が無くなる
export { RouteError as ErrorBoundary } from "../components/RouteError";
