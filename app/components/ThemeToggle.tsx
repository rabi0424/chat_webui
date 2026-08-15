import { useEffect, useState } from "react";
import { applyTheme, getTheme, type Theme } from "../lib/theme";
import { ACCENTS, applyAccent, DEFAULT_ACCENT, getAccent } from "../lib/accent";
import { IconAuto, IconMoon, IconSun } from "./icons";

const CYCLE: Theme[] = ["light", "dark", "system"];
const LABELS: Record<Theme, string> = {
  light: "ライト",
  dark: "ダーク",
  system: "自動",
};

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "light") return <IconSun className="h-4 w-4" />;
  if (theme === "dark") return <IconMoon className="h-4 w-4" />;
  return <IconAuto className="h-4 w-4" />;
}

/** テーマをライト→ダーク→自動の順で巡回するアイコンボタン。 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    setTheme(getTheme());
  }, []);

  // 「自動」のときは端末設定の変化に追従する
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const cycle = () => {
    const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length];
    setTheme(next);
    applyTheme(next);
  };

  return (
    <button
      type="button"
      onClick={cycle}
      title={`テーマ: ${LABELS[theme]}（クリックで切替）`}
      aria-label={`テーマ: ${LABELS[theme]}`}
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-900"
    >
      <ThemeIcon theme={theme} />
      {LABELS[theme]}
    </button>
  );
}

/**
 * アクセントカラーのピッカー（macOSのアクセントカラー選択と同じUI）。
 * 色付きの丸を並べ、選択中の色にリングを付ける。
 */
export function AccentPicker() {
  const [accent, setAccent] = useState(DEFAULT_ACCENT);

  useEffect(() => {
    setAccent(getAccent());
  }, []);

  const select = (id: string) => {
    setAccent(id);
    applyAccent(id);
  };

  return (
    <div
      role="radiogroup"
      aria-label="アクセントカラー"
      className="flex items-center justify-center gap-1.5"
    >
      {ACCENTS.map((a) => (
        <button
          key={a.id}
          type="button"
          role="radio"
          aria-checked={accent === a.id}
          aria-label={a.label}
          title={a.label}
          onClick={() => select(a.id)}
          style={{ backgroundColor: a.swatch }}
          className={`h-4 w-4 rounded-full transition active:scale-90 ${
            accent === a.id
              ? "ring-2 ring-neutral-400 ring-offset-2 ring-offset-white dark:ring-neutral-500 dark:ring-offset-neutral-950"
              : "hover:scale-110"
          }`}
        />
      ))}
    </div>
  );
}
