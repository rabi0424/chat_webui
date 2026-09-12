import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
  RETRY_WORKER_CONCURRENCY_RANGE,
  DAILY_DO_SECONDS_RANGE,
  type AppSettings,
} from "../lib/settings";
import { monthLabelJst } from "../lib/usage";
import { saveTheme, useTheme, type Theme } from "../lib/theme";
import {
  CHAT_FONT_SIZES,
  saveChatFontSize,
  useChatFontSize,
} from "../lib/chat-font";
import { HOME_STYLES, saveHomeStyle, useHomeStyle } from "../lib/home-style";
import {
  PASTE_CHARS_RANGE,
  PASTE_LINES_RANGE,
  savePasteThreshold,
  usePasteThreshold,
} from "../lib/paste";
import { AccentPicker } from "../components/ThemeToggle";
import { ModelPicker } from "../components/ModelPicker";
import { ParamsEditor } from "../components/ParamsEditor";
import {
  FIELD_AREA,
  Group,
  Row,
  Segmented,
  Stepper,
  Switch,
} from "../components/controls";
import { DEFAULT_MODEL } from "../lib/constants";
import { clearLastUsedModel, useLastUsedModel } from "../lib/persisted";
import { PROSE_INPUT } from "../lib/ui";
import type { ParamsState } from "../lib/params";
import {
  IconAuto,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconMenu,
  IconMoon,
  IconSun,
  IconTrash,
} from "../components/icons";
import { useConfirm } from "../components/ConfirmDialog";
import {
  ALL_PATHS_LABEL,
  DIMENSION_LABELS,
  clearSamples,
  currentBuildId,
  delta,
  flushSamples,
  formatHistory,
  historyRows,
  rowLabel,
  type HistoryRow,
  type PerfBuild,
  type PerfGroup,
} from "../lib/perf";
import { PERF_DIMENSIONS, type PerfDimension } from "../lib/schema";
import type { PerfHistoryResponse } from "../lib/api-types";

export function meta() {
  return [{ title: "設定 - Chat" }];
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

const THEMES: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "ライト", icon: <IconSun className="h-3.5 w-3.5" /> },
  { value: "dark", label: "ダーク", icon: <IconMoon className="h-3.5 w-3.5" /> },
  { value: "system", label: "自動", icon: <IconAuto className="h-3.5 w-3.5" /> },
];

/**
 * 一度に出すビルドの数。
 *
 * 集計はここに出すビルドの標本だけを読む（D1 は読んだ行数で課金される）。
 * 標本自体は消さずに全部残っているので、増やせばもっと遡れる。
 */
const HISTORY_BUILDS = 10;

/** 前回比の表示。速くなったら緑、遅くなったら赤。 */
function DeltaBadge({ cur, prev }: { cur: number; prev: number | null }) {
  const d = delta(cur, prev ?? undefined);
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
            : "text-ink-3"
      }`}
    >
      {sign}
      {d.ms}ms / {sign}
      {d.pct}%
    </span>
  );
}

/** 切り口とページの選択に使う小さなボタン。 */
function Chip({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-lg border px-2.5 py-1 text-xs ${
        selected
          ? "border-transparent bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
          : "border-line text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-white/5"
      }`}
    >
      {label}
    </button>
  );
}

/** 期間の表示。同じ日に始まって終わったビルドは日付を1度だけ出す。 */
function spanLabel(from: number, to: number): string {
  const day = (t: number) => new Date(t).toLocaleDateString("ja-JP");
  return day(from) === day(to) ? day(from) : `${day(from)} 〜 ${day(to)}`;
}

/** ビルド1つぶんの表。行は切り口の値（ページ・端末…）。 */
function BuildTable({
  rows,
  dimension,
}: {
  rows: HistoryRow[];
  dimension: PerfDimension;
}) {
  if (rows.length === 0) {
    return <p className="px-1 py-1 text-xs text-ink-3">記録がありません。</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-ink-3">
          <th className="px-1 py-0.5 font-normal">内訳</th>
          <th className="px-1 py-0.5 text-right font-normal">回数</th>
          <th className="px-1 py-0.5 text-right font-normal">中央値</th>
          <th className="px-1 py-0.5 text-right font-normal">p90</th>
        </tr>
      </thead>
      <tbody className="align-top">
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="truncate px-1 py-1 font-mono text-xs">
              {rowLabel(dimension, r)}
            </td>
            <td className="px-1 py-1 text-right tabular-nums">{r.count}</td>
            <td className="px-1 py-1 text-right tabular-nums">
              {r.median}ms
              <DeltaBadge cur={r.median} prev={r.prevMedian} />
            </td>
            <td className="px-1 py-1 text-right tabular-nums">
              {r.p90}ms
              <DeltaBadge cur={r.p90} prev={r.prevP90} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 起動と画面遷移の実測（lib/perf.ts → D1）。
 *
 * 引くたびに、まず控えを送り（この端末の記録をその場で反映させる）、
 * それからサーバーの集計を引く。**畳んでいるあいだは何もしない**——
 * 設定画面を開くたびに集計を引くと、見ていない表のために D1 を読む
 * ことになる（畳んだ `<details>` の中身も DOM には居る）。
 *
 * 差は「同じ内訳を持つ、次に古いビルド」との比較（historyRows）。
 */
function PerfPanel() {
  const [dimension, setDimension] = useState<PerfDimension>("path");
  /** 絞り込むページ。null は「すべてのページ」。 */
  const [path, setPath] = useState<string | null>(null);
  const [data, setData] = useState<PerfHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, flashCopied] = useCopied();
  const confirm = useConfirm();

  const load = useCallback(async (dim: PerfDimension, only: string | null) => {
    try {
      // 引く前に控えを送り**終えて**から引く。並べて投げると、いま測った
      // ぶんが間に合わず、表に出ないまま「記録がありません」に見える
      await flushSamples();
      const res = await fetch(
        `/api/perf?dimension=${dim}&builds=${HISTORY_BUILDS}` +
          (only ? `&path=${encodeURIComponent(only)}` : ""),
      );
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as PerfHistoryResponse;
      startTransition(() => {
        setData(json);
        setError(null);
      });
    } catch {
      setError("記録を読み込めませんでした");
    }
  }, []);

  useEffect(() => {
    void load(dimension, path);
  }, [load, dimension, path]);

  const history = data
    ? historyRows(data.builds as PerfBuild[], data.groups as PerfGroup[])
    : [];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        formatHistory(history, dimension, path),
      );
      flashCopied();
    } catch {
      // 権限がない環境では黙って何もしない
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {PERF_DIMENSIONS.map((d) => (
          <Chip
            key={d}
            label={DIMENSION_LABELS[d]}
            selected={d === dimension}
            onSelect={() => setDimension(d)}
          />
        ))}
      </div>

      {/*
        ページの絞り込み。起動と画面遷移を混ぜたまま端末別に見ると、
        中央値も p90 も「どちらの話か分からない数字」になる
        （起動は数秒、遷移は数十ミリ秒）。
      */}
      {(data?.paths.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1">
          <Chip
            label={ALL_PATHS_LABEL}
            selected={path === null}
            onSelect={() => setPath(null)}
          />
          {data!.paths.map((p) => (
            <Chip
              key={p}
              label={p}
              selected={p === path}
              onSelect={() => setPath(p)}
            />
          ))}
        </div>
      )}

      {error && <p className="px-1 text-sm text-red-600">{error}</p>}
      {!error && data && history.length === 0 && (
        <p className="px-1 py-2 text-sm text-ink-3">
          まだ記録がありません。ページを行き来すると自動で貯まります。
        </p>
      )}

      {history.map(({ build, rows }) => (
        <div key={build.build} className="space-y-1">
          <p className="px-1 text-xs font-medium text-ink-3">
            <span className="font-mono">{build.build}</span>
            {build.build === currentBuildId() && (
              <span className="ml-1 rounded bg-neutral-200 px-1 py-px text-[10px] text-neutral-700 dark:bg-white/10 dark:text-neutral-200">
                現行
              </span>
            )}{" "}
            ・ {spanLabel(build.firstAt, build.lastAt)}
          </p>
          <BuildTable rows={rows} dimension={dimension} />
        </div>
      ))}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void copy()}
          className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-white/5"
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
              title: "実測の記録をすべて消しますか？",
              // 消えるのはサーバー側の全履歴。端末ごとの控えとは別なので、
              // 「この端末だけ」と読めない文面にする
              description: "すべての端末・すべてのビルドの記録が消えます。過去バージョンとの比較はできなくなります。",
              confirmLabel: "消去",
              destructive: true,
            });
            if (!ok) return;
            clearSamples();
            await fetch("/api/perf", { method: "DELETE" });
            await load(dimension, path);
          }}
          aria-label="記録を消去"
          title="記録を消去"
          className="rounded-lg border border-line p-1.5 text-neutral-400 hover:bg-neutral-50 hover:text-neutral-600 dark:hover:bg-white/5 dark:hover:text-neutral-300"
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
  /**
   * 保存したばかりの項目。その行の右端に印を出す（ヘッダーに「保存しました」
   * と出すだけでは、どこが保存されたのか分からない）。
   */
  const [savedKeys, setSavedKeys] = useState<Set<keyof AppSettings>>(new Set());
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  /** 開発者向けの計測を開いているか（開くまで集計を引かない）。 */
  const [perfOpen, setPerfOpen] = useState(false);

  // 端末ごとの設定は localStorage。保存値を購読するので、
  // 別の場所で変えた分もここに出る（SSRでは既定値）
  const theme = useTheme();
  const chatFont = useChatFontSize();
  const homeStyle = useHomeStyle();
  const pasteThreshold = usePasteThreshold();

  /*
   * この端末で最後に使ったモデル。設定の既定より優先されるので、
   * いま効いている値としてここに出す。
   */
  const lastUsedModel = useLastUsedModel();

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  /** 走っている生成をすべて止める（溜まったアラームの一斉起動を断つ）。 */
  async function stopAll() {
    setStopping("止めています…");
    try {
      const res = await fetch("/api/generations/stop-all", { method: "POST" });
      const body = (await res.json()) as { stopped?: number };
      if (!res.ok) throw new Error();
      setStopping(`${body.stopped ?? 0}件に止まるよう伝えました`);
    } catch {
      setStopping("止められませんでした");
    }
  }

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
      setSavedKeys(new Set(Object.keys(patch) as (keyof AppSettings)[]));
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedKeys(new Set()), 1500);
    } catch {
      setError("設定を保存できませんでした");
      setSettings(settings);
    }
  }
  const saved = (key: keyof AppSettings) => savedKeys.has(key);

  const defaultModelId = settings.defaultModelId ?? DEFAULT_MODEL;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-black/[0.06] px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] dark:border-white/[0.06]">
        <div className="flex w-9 shrink-0 justify-start">
          <button
            type="button"
            onClick={openSidebar}
            aria-label="メニュー"
            className="rounded-lg p-2 text-ink-2 hover:bg-hover md:hidden"
          >
            <IconMenu className="h-5 w-5" />
          </button>
        </div>
        <h1 className="min-w-0 flex-1 truncate text-center text-[0.9375rem] font-semibold">
          設定
        </h1>
        <div className="flex w-9 shrink-0 justify-end" />
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

          <Group
            title="新規チャットの既定"
            note="ここで決めた内容は、会話を作った時点で写し取られます。あとで変えても、既にある会話は変わりません。ボットを選んで始めたときは、ボットの設定が優先されます。"
          >
            <Row
              label="既定のモデル"
              description="新しいチャットで最初に選ばれるモデル"
              saved={saved("defaultModelId")}
            >
              <ModelPicker
                models={models}
                value={defaultModelId}
                newModelDays={settings.newModelDays}
                onChange={(id) => void save({ defaultModelId: id })}
                variant="field"
              />
            </Row>
            {settings.defaultModelId !== null &&
              models.length > 0 &&
              !models.some((m) => m.id === settings.defaultModelId) && (
                /*
                 * 指定したモデルが一覧から消えた（提供終了・名前変更）。
                 * 黙って別のモデルで始めると、意図と違う額がかかる
                 */
                <p className="bg-amber-50 px-4 py-2.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
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
              <div className="flex items-center justify-between gap-3 bg-black/[0.03] px-4 py-2.5 text-xs dark:bg-white/[0.04]">
                <span className="min-w-0 text-neutral-600 dark:text-neutral-300">
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
              saved={saved("defaultSystemPrompt")}
              stack
            >
              <div className="w-full">
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
                  className={FIELD_AREA}
                />
                <p className="mt-1 text-right text-xs tabular-nums text-neutral-400">
                  {settings.defaultSystemPrompt.length} / {DEFAULT_SYSTEM_PROMPT_MAX}
                </p>
              </div>
            </Row>

            <Row
              label="生成パラメータ"
              description="ボットを使わないチャットの初期値。自動のままならモデル本来の既定に任せます"
              saved={saved("defaultParams")}
              stack
            >
              <div className="w-full">
                <ParamsEditor
                  model={models.find((m) => m.id === defaultModelId)}
                  value={settings.defaultParams as ParamsState}
                  onChange={(v) => void save({ defaultParams: v })}
                />
              </div>
            </Row>
          </Group>

          <Group
            title="生成"
            note="上流のAPIに繰り返し要求を出す機能の歯止め。会話ごとの設定はこの値を超えられません。"
          >
            <Row
              label="リトライの上限回数"
              description={`1回の依頼で許可する最大試行回数（${RETRY_CEILING_RANGE.min}〜${RETRY_CEILING_RANGE.max}）`}
              saved={saved("retryAttemptCeiling")}
            >
              <Stepper
                label="リトライの上限回数"
                value={settings.retryAttemptCeiling}
                min={RETRY_CEILING_RANGE.min}
                max={RETRY_CEILING_RANGE.max}
                step={1}
                onChange={(v) => void save({ retryAttemptCeiling: v })}
                width="w-14"
              />
            </Row>
            <Row
              label="担当1つの同時数"
              description={`0 で自動（Poe は6・それ以外は24）。1本あたりの実行体の時間は「生成時間 ÷ この数」で、無料枠の消費がそのまま決まります（最大${RETRY_WORKER_CONCURRENCY_RANGE.max}）`}
              saved={saved("retryWorkerConcurrency")}
            >
              <Stepper
                label="担当1つの同時数"
                value={settings.retryWorkerConcurrency}
                min={RETRY_WORKER_CONCURRENCY_RANGE.min}
                max={RETRY_WORKER_CONCURRENCY_RANGE.max}
                step={1}
                onChange={(v) => void save({ retryWorkerConcurrency: v })}
                width="w-14"
              />
            </Row>
            <Row
              label="1日の実行体の時間"
              description="秒。0 で歯止めなし。Cloudflare の無料枠は1日 約104,000秒で、使い切ると翌0時（UTC・日本時間の朝9時）までどの生成も始められなくなります"
              saved={saved("dailyDoSecondsBudget")}
            >
              <Stepper
                label="1日の実行体の時間"
                value={settings.dailyDoSecondsBudget}
                min={DAILY_DO_SECONDS_RANGE.min}
                max={DAILY_DO_SECONDS_RANGE.max}
                step={5_000}
                onChange={(v) => void save({ dailyDoSecondsBudget: v })}
                width="w-24"
              />
            </Row>
            <Row
              label="走っている生成をすべて止める"
              description="溜まった実行が一斉に動き出して枠を使い切るのを止めます。走り出している分は最後まで受け取ります"
            >
              <button
                type="button"
                onClick={() => void stopAll()}
                className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-hover"
              >
                {stopping ?? "すべて止める"}
              </button>
            </Row>
          </Group>

          <Group
            title="コスト"
            note="使った額は「使用量」で見られます。会話を消しても記録は残るので、消すことで上限が緩むことはありません。"
          >
            <Row
              label="月間の上限"
              description={`超えると生成を止めます（0 で上限なし・JSTの暦月・最大${MONTHLY_LIMIT_RANGE.max.toLocaleString()}円）`}
              saved={saved("monthlyLimitJpy")}
            >
              <Stepper
                label="月間の上限"
                value={settings.monthlyLimitJpy}
                min={MONTHLY_LIMIT_RANGE.min}
                max={MONTHLY_LIMIT_RANGE.max}
                step={100}
                onChange={(v) => void save({ monthlyLimitJpy: v })}
                width="w-20"
              />
            </Row>
            {settings.monthlyLimitJpy > 0 && (
              <Row
                label="今月だけ上限を解除"
                description="翌月には自動で戻ります（解除したまま忘れないため、恒久の設定にはしていません）"
                saved={saved("monthlyLimitOverride")}
              >
                <Switch
                  label="今月だけ上限を解除"
                  checked={settings.monthlyLimitOverride === thisMonth}
                  onChange={(on) =>
                    void save({ monthlyLimitOverride: on ? thisMonth : null })
                  }
                />
              </Row>
            )}
            <Row
              label="Poe のポイント換算"
              description="1ポイントあたりのドル。Poe が額を返さなかった分を上限の計算に入れます（0 で入れない）"
              saved={saved("poePointsUsdRate")}
            >
              <Stepper
                label="Poe のポイント換算"
                value={settings.poePointsUsdRate}
                min={POE_RATE_RANGE.min}
                max={POE_RATE_RANGE.max}
                step={0.0001}
                onChange={(v) => void save({ poePointsUsdRate: v })}
                width="w-20"
              />
            </Row>
          </Group>

          <Group
            title="モデル一覧"
            note="公開日はモデル一覧APIが申告する値。日付を返さないモデルには印を付けません。"
          >
            <Row
              label="新着として出す日数"
              description={`公開からこの日数だけ、モデル一覧の左端に印を付ける（0 で付けない・最大${NEW_MODEL_DAYS_RANGE.max}）`}
              saved={saved("newModelDays")}
            >
              <Stepper
                label="新着として出す日数"
                value={settings.newModelDays}
                min={NEW_MODEL_DAYS_RANGE.min}
                max={NEW_MODEL_DAYS_RANGE.max}
                step={1}
                onChange={(v) => void save({ newModelDays: v })}
                width="w-14"
              />
            </Row>
          </Group>

          <Group
            title="入力欄"
            note="この端末にのみ適用されます。長い貼り付けは本文に札だけを置き、送るときに中身へ戻します（モデルには全文が届きます）。"
          >
            <Row
              label="貼り付けを畳む字数"
              description={`この字数以上の貼り付けを札に畳む（0 で字数では畳まない・最大${PASTE_CHARS_RANGE.max.toLocaleString()}）`}
            >
              <Stepper
                label="貼り付けを畳む字数"
                value={pasteThreshold.chars}
                min={PASTE_CHARS_RANGE.min}
                max={PASTE_CHARS_RANGE.max}
                step={100}
                onChange={(v) => savePasteThreshold({ ...pasteThreshold, chars: v })}
                width="w-24"
              />
            </Row>
            <Row
              label="貼り付けを畳む行数"
              description={`この行数以上の貼り付けを札に畳む（0 で行数では畳まない・最大${PASTE_LINES_RANGE.max.toLocaleString()}）`}
            >
              <Stepper
                label="貼り付けを畳む行数"
                value={pasteThreshold.lines}
                min={PASTE_LINES_RANGE.min}
                max={PASTE_LINES_RANGE.max}
                step={1}
                onChange={(v) => savePasteThreshold({ ...pasteThreshold, lines: v })}
                width="w-20"
              />
            </Row>
          </Group>

          <Group title="外観" note="この端末にのみ適用されます。">
            <Row
              label="テーマ"
              description="端末の設定に追従するときは「自動」"
              stack="narrow"
            >
              <Segmented
                label="テーマ"
                value={theme}
                options={THEMES}
                onChange={(t) => saveTheme(t)}
              />
            </Row>
            <Row label="アクセント色" description="ボタンや強調表示の色" stack="narrow">
              <AccentPicker />
            </Row>
            <Row
              label="チャットの文字サイズ"
              description="会話画面の本文と入力欄の大きさ"
            >
              <Segmented
                label="チャットの文字サイズ"
                value={chatFont}
                options={CHAT_FONT_SIZES.map((f) => ({
                  value: f.value,
                  label: f.label,
                }))}
                onChange={(v) => saveChatFontSize(v)}
              />
            </Row>
            <div className="px-4 pb-3 text-xs text-ink-3">
              <span
                className="chat-text"
                style={{ display: "inline-block", lineHeight: 1.6 }}
              >
                この大きさで表示されます。
              </span>
            </div>
            <Row
              label="ホームの様式"
              description="新規チャットの画面。グラスは光の上にカード、ミニマルは大きな挨拶と罫線の一覧"
            >
              <Segmented
                label="ホームの様式"
                value={homeStyle}
                options={HOME_STYLES.map((s) => ({ value: s.value, label: s.label }))}
                onChange={(v) => saveHomeStyle(v)}
              />
            </Row>
          </Group>

          {/*
            開発者向けの計測は畳んでおく。利用者の設定と同じ重さで並べると、
            ビルドIDと p90 の表が「設定」の一部に見える。
          */}
          {/*
            畳んでいるあいだは PerfPanel を作らない。`<details>` の中身は
            閉じていても DOM に居るので、そのまま置くと設定画面を開く
            たびに集計を引くことになる
          */}
          <details
            open={perfOpen}
            onToggle={(e) => setPerfOpen(e.currentTarget.open)}
            className="group mb-7 rounded-2xl border border-black/[0.06] bg-white dark:border-white/[0.08] dark:bg-white/[0.04]"
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-neutral-600 dark:text-neutral-300 [&::-webkit-details-marker]:hidden">
              <IconChevronRight className="h-4 w-4 text-neutral-400 transition-transform group-open:rotate-90" />
              開発者向け: 起動とページ遷移の計測
            </summary>
            <div className="border-t border-black/[0.06] px-4 py-3 dark:border-white/[0.08]">
              <p className="mb-3 text-xs leading-relaxed text-ink-2">
                起動と画面遷移の所要時間を1件ずつ残しています（間引きなし）。端末・ブラウザ・表示形態・ビルドごとに分けて見られ、デプロイをまたいだ推移も辿れます。数値の下は、同じ内訳を持つ一つ前のビルドとの差です。
              </p>
              {perfOpen && <PerfPanel />}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}


// 例外の受け皿はこのルートに置く。root に任せると文書ごと
// 差し替わり、サイドバーまで消えて戻る導線が無くなる
export { RouteError as ErrorBoundary } from "../components/RouteError";
