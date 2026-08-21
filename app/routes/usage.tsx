import { useOutletContext } from "react-router";
import type { Route } from "./+types/usage";
import type { ShellContext } from "./shell";
import {
  getAppSettings,
  readStoredUsdJpy,
  usageByModelSince,
  usageTotalsSince,
  type UsageByModel,
} from "../lib/db.server";
import {
  checkLimit,
  monthLabelJst,
  monthStartJst,
  type UsageTotals,
} from "../lib/usage";
import { IconMenu } from "../components/icons";

export function meta() {
  return [{ title: "使用量 - Chat WebUI" }];
}

/** 直近この日数ぶんも併せて見せる（月初は月次だけだと様子が分からない）。 */
const RECENT_DAYS = 7;

export async function loader() {
  const now = Date.now();
  const monthStart = monthStartJst(now);
  const recentStart = now - RECENT_DAYS * 24 * 60 * 60 * 1000;

  const [settings, month, recent, byModel, usdJpy] = await Promise.all([
    getAppSettings(),
    usageTotalsSince(monthStart),
    usageTotalsSince(recentStart),
    usageByModelSince(monthStart),
    readStoredUsdJpy(),
  ]);

  return {
    now,
    month,
    recent,
    byModel,
    usdJpy,
    limitJpy: settings.monthlyLimitJpy,
    verdict: checkLimit({
      limitJpy: settings.monthlyLimitJpy,
      usdJpy,
      totals: month,
      pointsUsdRate: settings.poePointsUsdRate,
      overrideMonth: settings.monthlyLimitOverride,
      now,
    }),
  };
}

/** モデルIDは長いので、末尾の名前だけ出す。 */
function modelName(id: string | null): string {
  if (!id) return "（不明）";
  return id.replace(/^poe:/, "").split("/").pop() ?? id;
}

/** ドル建て。少額なので桁を落とさない。 */
function usd(v: number): string {
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function jpy(v: number): string {
  return `¥${Math.round(v).toLocaleString()}`;
}

/** 使用額と上限の帯。上限が無ければ額だけ。 */
function LimitBar({
  usedJpy,
  limitJpy,
}: {
  usedJpy: number;
  limitJpy: number;
}) {
  const ratio = Math.min(usedJpy / limitJpy, 1);
  // 8割を超えたら色を変える。数字だけだと近づいたことに気づきにくい
  const tone =
    ratio >= 1
      ? "bg-red-500"
      : ratio >= 0.8
        ? "bg-amber-500"
        : "bg-accent";
  return (
    <div className="mt-3">
      <div className="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
        <div
          className={`h-full rounded-full transition-all ${tone}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
        上限 {jpy(limitJpy)} の {Math.round(ratio * 100)}%
      </p>
    </div>
  );
}

function Totals({
  title,
  totals,
  usdJpy,
}: {
  title: string;
  totals: UsageTotals;
  usdJpy: number | null;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
        {title}
      </p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">
        {usdJpy != null ? jpy(totals.costUsd * usdJpy) : usd(totals.costUsd)}
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {usdJpy != null && `${usd(totals.costUsd)}・`}
        {totals.events}件
        {totals.points > 0 &&
          `・${Math.round(totals.points).toLocaleString()} pt`}
      </p>
    </div>
  );
}

function ByModel({
  rows,
  usdJpy,
}: {
  rows: UsageByModel[];
  usdJpy: number | null;
}) {
  if (rows.length === 0) return null;
  const top = rows[0].costUsd;
  return (
    <div className="mt-8">
      <h2 className="mb-2 text-sm font-semibold">モデル別（今月）</h2>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={`${r.provider}:${r.modelId}`} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">
                {modelName(r.modelId)}
                <span className="ml-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {r.events}件
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-neutral-600 dark:text-neutral-300">
                {usdJpy != null ? jpy(r.costUsd * usdJpy) : usd(r.costUsd)}
                {r.points > 0 && (
                  <span className="ml-1.5 text-xs text-neutral-400">
                    {Math.round(r.points).toLocaleString()} pt
                  </span>
                )}
              </span>
            </div>
            {/* 額の大小を目で追えるように、一番使ったモデルを基準にした帯を敷く */}
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-900">
              <div
                className="h-full rounded-full bg-accent/60"
                style={{ width: `${top > 0 ? (r.costUsd / top) * 100 : 0}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Usage({ loaderData }: Route.ComponentProps) {
  const { month, recent, byModel, usdJpy, verdict, now } = loaderData;
  const { openSidebar } = useOutletContext<ShellContext>();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-[calc(1rem+env(safe-area-inset-top))]">
        <header className="mb-6 flex items-center gap-2">
          <button
            type="button"
            onClick={openSidebar}
            aria-label="メニュー"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-neutral-100 active:scale-95 lg:hidden dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <IconMenu className="h-5 w-5" />
          </button>
          <h1 className="text-xl font-semibold tracking-tight">使用量</h1>
          <span className="ml-auto text-xs text-neutral-500 dark:text-neutral-400">
            {monthLabelJst(now)}（JST）
          </span>
        </header>

        <div className="grid grid-cols-2 gap-4">
          <Totals title="今月" totals={month} usdJpy={usdJpy} />
          <Totals
            title={`直近${RECENT_DAYS}日`}
            totals={recent}
            usdJpy={usdJpy}
          />
        </div>

        {verdict.limitJpy > 0 && verdict.usedJpy != null && (
          <LimitBar usedJpy={verdict.usedJpy} limitJpy={verdict.limitJpy} />
        )}

        {/*
          判定に混ざっている不確かさは、黙って飲み込まずに出す。
          「上限まであといくら」を信じて使う画面なので、根拠が
          揺れているならそう見えていないといけない。
        */}
        {verdict.reason === "no-rate" && (
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            為替レートを取得できていないため、円換算と上限の判定ができません。
            上限には達していない扱いで生成を続けます。
          </p>
        )}
        {verdict.reason === "override" && (
          <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            今月は上限を一時解除しています（翌月には自動で戻ります）。
          </p>
        )}
        {verdict.estimated && (
          <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
            Poe の消費のうち、額が取れなかった分はポイントから見積もっています。
          </p>
        )}
        {month.pointsWithoutCost > 0 && !verdict.estimated && (
          <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
            Poe の {Math.round(month.pointsWithoutCost).toLocaleString()} pt は
            額が取れておらず、上限の計算に入っていません（設定で換算レートを
            決めると加えられます）。
          </p>
        )}

        <ByModel rows={byModel} usdJpy={usdJpy} />

        {month.events === 0 && (
          <p className="mt-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
            今月の記録はまだありません
          </p>
        )}

        <p className="mt-10 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          会話やメッセージを削除しても、ここの記録は残ります。使った額は
          戻らないので、消すことで上限が緩まないようにしてあります。
        </p>
      </div>
    </div>
  );
}


// 例外の受け皿はこのルートに置く。root に任せると文書ごと
// 差し替わり、サイドバーまで消えて戻る導線が無くなる
export { RouteError as ErrorBoundary } from "../components/RouteError";
