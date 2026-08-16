import { useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { Route } from "./+types/settings";
import type { ShellContext } from "./shell";
import { getAppSettings } from "../lib/db.server";
import { RETRY_CEILING_RANGE, type AppSettings } from "../lib/settings";
import { applyTheme, getTheme, type Theme } from "../lib/theme";
import { AccentPicker } from "../components/ThemeToggle";
import { NumberInput } from "../components/NumberInput";
import { IconMenu } from "../components/icons";

export function meta({}: Route.MetaArgs) {
  return [{ title: "設定 - Chat WebUI" }];
}

export async function loader() {
  return { settings: await getAppSettings() };
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

export default function Settings({ loaderData }: Route.ComponentProps) {
  const { openSidebar } = useOutletContext<ShellContext>();
  const [settings, setSettings] = useState<AppSettings>(loaderData.settings);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 端末ごとの設定はlocalStorage。描画後に読む（SSRでは参照できない）
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    setTheme(getTheme());
  }, []);

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
        <div className="mx-auto max-w-2xl p-4">
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

          <Section title="外観" note="この端末にのみ適用されます。">
            <Row label="テーマ" description="ライト / ダーク / 端末設定に追従">
              <select
                value={theme}
                onChange={(e) => {
                  const next = e.target.value as Theme;
                  setTheme(next);
                  applyTheme(next);
                }}
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
          </Section>
        </div>
      </div>
    </div>
  );
}
