import { saveTheme, useTheme, type Theme } from "../lib/theme";
import { ACCENTS, saveAccent, useAccent } from "../lib/accent";
import { IconAuto, IconMoon, IconSun } from "./icons";
import { GLASS_ICON_BUTTON } from "../lib/ui";

const CYCLE: Theme[] = ["light", "dark", "system"];
const LABELS: Record<Theme, string> = {
  light: "ライト",
  dark: "ダーク",
  system: "自動",
};

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "light") return <IconSun className="h-5 w-5" />;
  if (theme === "dark") return <IconMoon className="h-5 w-5" />;
  return <IconAuto className="h-5 w-5" />;
}

/**
 * テーマをライト→ダーク→自動の順で巡回するアイコンボタン。
 * サイドバー下部にガラスの丸ボタンとして並ぶため、ラベルは持たない
 * （現在のテーマは title / aria-label で伝える）。
 */
export function ThemeToggle() {
  // 保存値を購読する。設定画面で変えたときもここが揃って動く
  // （自分で state を持つと、片方で変えたあとに押すと一手ずれた）。
  //
  // 「自動」での端末設定への追従は、アプリ全体の貼り直し
  // （lib/appearance.ts の useAppearanceSync）がまとめて見ている。
  const theme = useTheme();

  const cycle = () => {
    saveTheme(CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length]);
  };

  return (
    <button
      type="button"
      onClick={cycle}
      title={`テーマ: ${LABELS[theme]}（クリックで切替）`}
      aria-label={`テーマ: ${LABELS[theme]}`}
      className={GLASS_ICON_BUTTON}
    >
      <ThemeIcon theme={theme} />
    </button>
  );
}

/**
 * アクセントカラーのピッカー（macOSのアクセントカラー選択と同じUI）。
 * 色付きの丸を並べ、選択中の色にリングを付ける。
 */
export function AccentPicker() {
  const accent = useAccent();
  const select = (id: string) => saveAccent(id);

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
          /*
            指の端末では縦だけ当たり判定を伸ばす（bg-clip-content と
            合わせて、見た目の丸は16pxのまま）。横に広げると隣の色と
            重なって、押したつもりと違う色が選ばれる。
          */
          className={`h-4 w-4 rounded-full bg-clip-content transition active:scale-90 touch:h-11 touch:border-y-[0.875rem] touch:border-y-transparent ${
            accent === a.id
              ? "ring-2 ring-neutral-400 ring-offset-2 ring-offset-white dark:ring-neutral-500 dark:ring-offset-neutral-950"
              : "hover:scale-110"
          }`}
        />
      ))}
    </div>
  );
}
