/**
 * 削除の選択モードのときに、入力欄の代わりに出る帯。
 *
 * 消すのは取り消せないので、入力欄と入れ替える形にしている
 * （送るつもりで削除を押す、という取り違えが起きないように）。
 */
export function SelectionBar({
  count,
  hasContextBoundary,
  onCancel,
  onDelete,
}: {
  count: number;
  /** 会話のどこかにコンテキストの境界線がある。選んで消せると案内する。 */
  hasContextBoundary: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-3xl border border-neutral-200/80 bg-white/85 px-4 py-2.5 shadow-lg shadow-black/5 backdrop-blur-xl backdrop-saturate-150 dark:border-white/10 dark:bg-neutral-900/80">
      <span className="min-w-0 flex-1 text-sm text-neutral-500 dark:text-neutral-400">
        {count}件選択中（タップで選択/解除）
        {hasContextBoundary && (
          <span className="block text-xs text-neutral-400 dark:text-neutral-500">
            コンテキストクリアも選んで消せます
          </span>
        )}
      </span>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl px-4 py-2 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={count === 0}
          className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-30"
        >
          削除
        </button>
      </div>
    </div>
  );
}
