import { useState } from "react";
import { useOutletContext } from "react-router";
import type { Route } from "./+types/usage";
import type { ShellContext } from "./shell";
import {
  getAppSettings,
  readStoredUsdJpy,
  readUsageOverview,
  type StorageStats,
  type UsageByModel,
} from "../lib/db.server";
import {
  FREE_TIER,
  USAGE_RANGES,
  USAGE_RANGE_LABELS,
  checkLimit,
  formatBytes,
  monthLabelJst,
  type UsageRange,
  type UsageTotals,
} from "../lib/usage";
import { IconMenu } from "../components/icons";
import { providerColor } from "../components/ModelPicker";
import { dailyChart, daysInMonthJst } from "../lib/usage-chart";

export function meta() {
  return [{ title: "使用量 - Chat" }];
}

export async function loader() {
  const now = Date.now();
  const [settings, overview, usdJpy] = await Promise.all([
    getAppSettings(),
    // 期間ごとの合計・内訳と、保管しているものの大きさを1回のbatchで読む
    readUsageOverview(now),
    readStoredUsdJpy(),
  ]);
  const month = overview.totals.month;

  return {
    now,
    totals: overview.totals,
    byModel: overview.byModel,
    storage: overview.storage,
    daily: overview.daily,
    usdJpy,
    limitJpy: settings.monthlyLimitJpy,
    pointsUsdRate: settings.poePointsUsdRate,
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
      <p className="mt-1.5 text-xs text-ink-2">
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
      <p className="text-xs font-medium text-ink-2">
        {title}
      </p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">
        {usdJpy != null ? jpy(totals.costUsd * usdJpy) : usd(totals.costUsd)}
      </p>
      <p className="text-xs text-ink-2">
        {usdJpy != null && `${usd(totals.costUsd)}・`}
        {totals.events}件
        {totals.points > 0 &&
          `・${Math.round(totals.points).toLocaleString()} pt`}
      </p>
    </div>
  );
}

/** ベンダーの見出し。綴りに癖のあるものだけ手で持ち、あとは頭を大文字に。 */
const VENDOR_LABELS: Record<string, string> = {
  openai: "OpenAI",
  "x-ai": "xAI",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  poe: "Poe",
};
function vendorLabel(vendor: string): string {
  return VENDOR_LABELS[vendor] ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

/**
 * 今月の日別グラフ（UI-8）。
 *
 * SVG ではなく flex の棒で描く。SVG だと viewBox に合わせて文字まで
 * 伸び縮みし、iPhone の幅では日付が読めなくなる。高さは % で持ち、
 * 上限の線も同じ % で置くので、棒と線の基準は必ず一致する。
 */
function DailyChart({
  daily,
  now,
  usdJpy,
  limitJpy,
  pointsUsdRate,
}: {
  daily: Route.ComponentProps["loaderData"]["daily"];
  now: number;
  usdJpy: number | null;
  limitJpy: number;
  pointsUsdRate: number;
}) {
  const { bars, vendors } = dailyChart(daily, now, pointsUsdRate);
  if (vendors.length === 0) return null;
  const money = (v: number) => (usdJpy != null ? jpy(v * usdJpy) : usd(v));
  const dayLabel = (b: (typeof bars)[number]) => {
    const d = new Date(b.at + 9 * 60 * 60 * 1000);
    return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  };
  /*
   * 上限は月の額なので、1日あたりに割った線を引く。毎日この線の下なら
   * 月末に上限へ届かない、という目安。円のレートが無いと引けない
   * （棒はドルで持ち、線は円で決まっているため）。
   */
  const daysInMonth = daysInMonthJst(now);
  const limitPerDayUsd =
    limitJpy > 0 && usdJpy != null ? limitJpy / daysInMonth / usdJpy : null;
  /*
   * 棒の並びは月の日数ぶんの幅に置く。今日までの日数で幅を割ると、
   * 月初は棒が数本で画面いっぱいに太り、月末に向かって細っていく。
   * 残りの日を空けておけば、月の中のどこにいるかも一目で分かる。
   */
  const elapsedWidth = `${(bars.length / daysInMonth) * 100}%`;
  const peak = Math.max(...bars.map((b) => b.usd), limitPerDayUsd ?? 0);
  // 天井に少し余白を取る（一番高い棒が上端に貼り付くと線と見分けにくい）
  const top = peak > 0 ? peak * 1.15 : 1;
  const pct = (v: number) => `${(v / top) * 100}%`;
  const color = (vendor: string) =>
    providerColor(vendors.find((v) => v.vendor === vendor)?.sample ?? vendor);
  // 日付の目盛りは 1・10・20・今日。全部出すと iPhone の幅で潰れる
  const last = bars[bars.length - 1].dayOfMonth;
  const ticks = new Set([1, 10, 20, last].filter((d) => d <= last));

  return (
    <div className="mt-8">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">日別（今月）</h2>
        {limitPerDayUsd != null && (
          <span className="text-xs text-ink-2">
            点線は上限を日割りした {money(limitPerDayUsd)}
          </span>
        )}
      </div>
      <div className="rounded-xl border border-line px-3.5 pb-2 pt-4">
        <div className="relative h-32">
          <ul
            aria-label="日別の使用額"
            className="absolute inset-y-0 left-0 flex items-end gap-px sm:gap-0.5"
            style={{ width: elapsedWidth }}
          >
            {bars.map((b) => (
              <li
                key={b.dayOfMonth}
                aria-label={`${dayLabel(b)} ${money(b.usd)}`}
                className="group relative flex h-full flex-1 flex-col-reverse"
              >
                {b.parts.map(
                  (p) =>
                    p.usd > 0 && (
                      <span
                        key={p.vendor}
                        aria-hidden
                        className="block w-full first:rounded-t-sm"
                        style={{
                          height: pct(p.usd),
                          backgroundColor: color(p.vendor),
                        }}
                      />
                    ),
                )}
                {/* 棒が無い日も、指で触れる場所として最低限の高さを残す */}
                {b.usd === 0 && (
                  <span
                    aria-hidden
                    className="block h-px w-full bg-neutral-200 dark:bg-neutral-800"
                  />
                )}
              </li>
            ))}
          </ul>
          {/* 線は棒の上に重ねる（下に敷くと、線を越えた日ほど見えなくなる） */}
          {limitPerDayUsd != null && (
            <div
              data-testid="limit-line"
              aria-hidden
              className="pointer-events-none absolute inset-x-0 border-t border-dashed border-neutral-500/70 dark:border-neutral-400/70"
              style={{ bottom: pct(limitPerDayUsd) }}
            />
          )}
        </div>
        <div
          className="mt-1.5 flex text-[0.625rem] tabular-nums text-neutral-400"
          style={{ width: elapsedWidth }}
        >
          {bars.map((b) => (
            <span key={b.dayOfMonth} className="flex-1 text-center">
              {ticks.has(b.dayOfMonth) ? b.dayOfMonth : ""}
            </span>
          ))}
        </div>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-300">
        {vendors.map((v) => (
          <li key={v.vendor} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2 w-2 rounded-[3px]"
              style={{ backgroundColor: providerColor(v.sample || v.vendor) }}
            />
            <span>{vendorLabel(v.vendor)}</span>
            <span className="tabular-nums text-neutral-400">{money(v.usd)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ByModel({
  rows,
  label,
  usdJpy,
}: {
  rows: UsageByModel[];
  /** どの期間の内訳か（見出しに出す）。 */
  label: string;
  usdJpy: number | null;
}) {
  if (rows.length === 0) return null;
  const top = rows[0].costUsd;
  return (
    <div className="mt-8">
      <h2 className="mb-2 text-sm font-semibold">モデル別（{label}）</h2>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={`${r.provider}:${r.modelId}`} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">
                {modelName(r.modelId)}
                <span className="ml-1.5 text-xs text-ink-2">
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
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken">
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

/** 使用量に対する割合の帯（無料枠の目安に対して、いまどれくらいか）。 */
function QuotaBar({ used, limit }: { used: number; limit: number }) {
  const ratio = Math.min(used / limit, 1);
  const tone =
    ratio >= 1 ? "bg-red-500" : ratio >= 0.8 ? "bg-amber-500" : "bg-accent/60";
  return (
    <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken">
      <div
        className={`h-full rounded-full ${tone}`}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}

/**
 * Cloudflare 側の使用状況。
 *
 * 課金額は出さない——Cloudflare には個人アカウントの請求額を返す API が
 * 無く、無理に見積もると「アプリが言った額」と実際の請求がずれる。
 * 代わりに、無料枠を使い切りそうかどうかが分かる大きさを出す
 * （超過は課金ではなく失敗として現れる。要件 §3.6 の運用面の前提）。
 */
function Cloudflare({ storage }: { storage: StorageStats }) {
  const rows: { label: string; value: string; note?: string }[] = [
    {
      label: "会話",
      value: `${storage.conversations.toLocaleString()}件`,
      note: `メッセージ ${storage.messages.toLocaleString()}件`,
    },
    {
      label: "使用量の記録",
      value: `${storage.usageEvents.toLocaleString()}件`,
    },
  ];
  return (
    <div className="mt-8">
      <h2 className="mb-2 text-sm font-semibold">保存しているもの</h2>
      <div className="space-y-3 rounded-xl border border-line px-3.5 py-3">
        <div>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span>
              会話の保存
              <span className="ml-1.5 text-xs text-neutral-400">D1</span>
            </span>
            <span className="tabular-nums text-neutral-600 dark:text-neutral-300">
              {storage.d1Bytes != null ? formatBytes(storage.d1Bytes) : "—"}
            </span>
          </div>
          {storage.d1Bytes != null ? (
            <>
              <QuotaBar used={storage.d1Bytes} limit={FREE_TIER.d1Bytes} />
              <p className="mt-1 text-xs text-ink-2">
                無料枠の目安 {formatBytes(FREE_TIER.d1Bytes)} の{" "}
                {Math.round((storage.d1Bytes / FREE_TIER.d1Bytes) * 1000) / 10}%
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-ink-2">
              大きさを取得できませんでした。
            </p>
          )}
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span>
              画像・添付の保存
              <span className="ml-1.5 text-xs text-neutral-400">R2</span>
            </span>
            <span className="tabular-nums text-neutral-600 dark:text-neutral-300">
              {formatBytes(storage.fileBytes)}
            </span>
          </div>
          <QuotaBar used={storage.fileBytes} limit={FREE_TIER.r2Bytes} />
          <p className="mt-1 text-xs text-ink-2">
            {storage.files.toLocaleString()}個・無料枠の目安{" "}
            {formatBytes(FREE_TIER.r2Bytes)} の{" "}
            {Math.round((storage.fileBytes / FREE_TIER.r2Bytes) * 1000) / 10}%
            {storage.pendingDeletions > 0 &&
              `（削除待ち ${storage.pendingDeletions}個を含む）`}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-line pt-3 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-2">
              <dt className="text-ink-2">
                {r.label}
              </dt>
              <dd className="tabular-nums">
                {r.value}
                {r.note && (
                  <span className="ml-1.5 text-xs text-neutral-400">
                    {r.note}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-2">
        R2 の大きさは、こちらが記録している添付の合計です（同じ実体を
        共有している分は1つとして数えます）。Cloudflare の請求額は API から
        取れないため出していません。無料枠の値は目安で、変わることがあります。
      </p>
    </div>
  );
}

export default function Usage({ loaderData }: Route.ComponentProps) {
  const { totals, byModel, storage, daily, usdJpy, verdict, now } = loaderData;
  const { openSidebar } = useOutletContext<ShellContext>();
  /**
   * 見ている期間。3つとも読んであるので、切り替えても通信は起きない
   * （押すたびにサーバーへ行くと、親レイアウトのローダーまで走り直す）。
   */
  const [range, setRange] = useState<UsageRange>("month");
  const month = totals.month;
  const shown = totals[range];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-[calc(1rem+env(safe-area-inset-top))]">
        <header className="mb-6 flex items-center gap-2">
          <button
            type="button"
            onClick={openSidebar}
            aria-label="メニュー"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-2 transition hover:bg-hover active:scale-95 lg:hidden"
          >
            <IconMenu className="h-5 w-5" />
          </button>
          <h1 className="text-xl font-semibold tracking-tight">使用量</h1>
          <span className="ml-auto text-xs text-ink-2">
            {monthLabelJst(now)}（JST）
          </span>
        </header>

        {/* 期間の切り替え。押した期間の合計・内訳がその場で入れ替わる */}
        <div
          role="group"
          aria-label="期間"
          className="mb-4 inline-flex rounded-xl border border-line p-0.5"
        >
          {USAGE_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              aria-pressed={range === r}
              className={`rounded-[0.625rem] px-3 py-1.5 text-xs font-medium ${
                range === r
                  ? "bg-accent/10 text-accent-ink"
                  : "text-ink-2 hover:bg-hover"
              }`}
            >
              {USAGE_RANGE_LABELS[r]}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Totals
            title={USAGE_RANGE_LABELS[range]}
            totals={shown}
            usdJpy={usdJpy}
          />
          {/*
            上限は月ごとの決まりなので、別の期間を見ているあいだも
            「今月いくら使ったか」は隣に出しておく（帯の根拠でもある）。
          */}
          {range !== "month" && (
            <Totals title="今月" totals={month} usdJpy={usdJpy} />
          )}
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
          <p className="mt-3 text-xs text-ink-2">
            Poe の消費のうち、額が取れなかった分はポイントから見積もっています。
          </p>
        )}
        {month.pointsWithoutCost > 0 && !verdict.estimated && (
          <p className="mt-3 text-xs text-ink-2">
            Poe の {Math.round(month.pointsWithoutCost).toLocaleString()} pt は
            額が取れておらず、上限の計算に入っていません（設定で換算レートを
            決めると加えられます）。
          </p>
        )}

        <DailyChart
          daily={daily}
          now={now}
          usdJpy={usdJpy}
          limitJpy={verdict.limitJpy}
          pointsUsdRate={loaderData.pointsUsdRate}
        />

        <ByModel
          rows={byModel[range]}
          label={USAGE_RANGE_LABELS[range]}
          usdJpy={usdJpy}
        />

        {shown.events === 0 && (
          <p className="mt-10 text-center text-sm text-ink-2">
            {USAGE_RANGE_LABELS[range]}の記録はまだありません
          </p>
        )}

        <Cloudflare storage={storage} />

        <p className="mt-10 text-xs leading-relaxed text-ink-2">
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
