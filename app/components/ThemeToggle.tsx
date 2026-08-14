import { useEffect, useState } from "react";
import { applyTheme, getTheme, type Theme } from "../lib/theme";

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
  { value: "system", label: "自動" },
];

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

  const select = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
  };

  return (
    <div
      className="flex rounded-lg border border-gray-200 p-0.5 dark:border-gray-700"
      role="radiogroup"
      aria-label="テーマ"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={theme === o.value}
          onClick={() => select(o.value)}
          className={`flex-1 rounded-md px-2 py-1 text-xs ${
            theme === o.value
              ? "bg-gray-100 font-medium text-gray-800 dark:bg-gray-800 dark:text-gray-100"
              : "text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
