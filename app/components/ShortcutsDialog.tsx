/**
 * ショートカットの一覧（⌘/）。
 *
 * 表は lib/shortcuts.ts のもの。ここで書き写すと、キーを足したときに
 * 一覧が古いままになる。出し方は確認ダイアログと同じ——iPhone では
 * 下端のシート、Mac では中央のダイアログ。
 */
import { useCallback } from "react";
import { useEscapeToClose } from "../lib/dismiss";
import { SHORTCUTS, formatKeys } from "../lib/shortcuts";
import { GLASS_PANEL } from "../lib/ui";

export function ShortcutsDialog({
  mac,
  onClose,
}: {
  mac: boolean;
  onClose: () => void;
}) {
  const close = useCallback(() => onClose(), [onClose]);
  useEscapeToClose(true, close);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-2 backdrop-blur-sm animate-fade md:items-center md:p-4"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className={`w-full max-w-md rounded-2xl p-4 pb-[max(env(safe-area-inset-bottom),1rem)] animate-sheet md:pb-4 md:animate-pop ${GLASS_PANEL}`}
        onClick={(e) => e.stopPropagation()}
      >
        <p id="shortcuts-title" className="font-display text-base font-bold">
          キーボードショートカット
        </p>
        <dl className="mt-3 divide-y divide-line text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-4 py-2">
              <dt>{s.label}</dt>
              <dd>
                <kbd className="rounded-md border border-line bg-sunken px-1.5 py-0.5 font-sans text-xs tabular-nums text-ink-2">
                  {formatKeys(s, mac)}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={close}
            autoFocus
            className="rounded-xl border border-line px-4 py-3 text-sm text-neutral-700 hover:bg-hover md:py-1.5 dark:text-neutral-200"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
