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
    <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-3xl border border-neutral-200/80 bg-white/[0.92] px-4 py-2.5 shadow-lg shadow-black/5 backdrop-blur-2xl backdrop-saturate-150 dark:border-white/[0.12] dark:bg-[#1c1c1e]/90">
      {/* 件数は太く、案内は2行目に固定（1行に詰めると iPhone で折れていた。監査 D-13） */}
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold tabular-nums">
          {count}件選択中
        </span>
        <span className="block text-xs text-ink-3">
          {hasContextBoundary
            ? "タップで選択／解除。コンテキストクリアも選んで消せます"
            : "タップで選択／解除"}
        </span>
      </span>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-4 py-2.5 text-sm text-ink-2 hover:bg-hover"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={count === 0}
          className="rounded-full bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-500 disabled:bg-neutral-200 disabled:text-neutral-400 dark:disabled:bg-white/10 dark:disabled:text-white/40"
        >
          削除
        </button>
      </div>
    </div>
  );
}
