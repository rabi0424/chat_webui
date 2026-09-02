/**
 * 確認のダイアログ。ブラウザの confirm() の置き換え。
 *
 * confirm() は見た目を変えられず、iPhone ではシートの上に OS のアラートが
 * 被って、作り込んだ画面の外へ一度出る。ここでは同じ中身（見出し・説明・
 * 選択肢）を、**iPhone では画面の下端から上がるシート**、**Mac では中央の
 * ダイアログ**として出す。出し方の違いは幅（md）で切り替えるだけで、
 * 部品は1つ。
 *
 * 呼ぶ側は `const confirm = useConfirm()` で Promise<boolean> を受け取り、
 * これまでの `if (!confirm(...)) return;` と同じ形で書ける。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useEscapeToClose } from "../lib/dismiss";
import { GLASS_PANEL } from "../lib/ui";

export interface ConfirmOptions {
  title: string;
  /** 何が消えて何が残るか、を1〜2文で。 */
  description?: string;
  /** 主ボタンの文言。「削除」「実行」のように動詞で。 */
  confirmLabel?: string;
  cancelLabel?: string;
  /** 取り消せない操作。主ボタンを赤にする。 */
  destructive?: boolean;
}

type Ask = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask | null>(null);

/**
 * 確認を出す関数を返す。
 *
 * ConfirmProvider の外で呼ぶと投げる。黙って true を返す作りにすると、
 * 配線を忘れた画面で「確認なしに消える」ことになり、こちらのほうが怖い。
 */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error("ConfirmProvider の外で確認を出そうとしています");
  return ask;
}

interface Pending {
  options: ConfirmOptions;
  resolve: (answer: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback<Ask>((options) => {
    return new Promise<boolean>((resolve) => {
      // 前の確認が残っていたら「いいえ」で閉じる。重ねて出す状況は無いが、
      // 置き去りにすると Promise が永久に待つ
      setPending((prev) => {
        prev?.resolve(false);
        return { options, resolve };
      });
    });
  }, []);

  const answer = useCallback(
    (value: boolean) => {
      setPending((prev) => {
        prev?.resolve(value);
        return null;
      });
    },
    [],
  );

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {pending && (
        <ConfirmDialog options={pending.options} onAnswer={answer} />
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * 見た目。
 *
 * iPhone（md 未満）: 下端のシート。主ボタンとキャンセルが縦に並び、
 * どちらも指で押せる高さ。取り消せない操作は主ボタンが赤。
 * Mac（md 以上）: 中央のダイアログ。ボタンは右寄せの横並び。
 *
 * 開いたら主ボタンにフォーカスを置く。Enter で確定、Escape で取りやめ。
 * 中央のダイアログで Enter が「消す」になるのは confirm() と同じ。
 */
function ConfirmDialog({
  options,
  onAnswer,
}: {
  options: ConfirmOptions;
  onAnswer: (value: boolean) => void;
}) {
  const {
    title,
    description,
    confirmLabel = "OK",
    cancelLabel = "キャンセル",
    destructive = false,
  } = options;
  const cancel = useCallback(() => onAnswer(false), [onAnswer]);
  useEscapeToClose(true, cancel);

  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primary.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-2 backdrop-blur-sm animate-fade md:items-center md:p-4"
      onClick={cancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className={`w-full max-w-md rounded-2xl p-4 pb-[max(env(safe-area-inset-bottom),1rem)] animate-sheet md:max-w-sm md:pb-4 md:animate-pop ${GLASS_PANEL}`}
        onClick={(e) => e.stopPropagation()}
      >
        <p id="confirm-title" className="font-display text-base font-bold">
          {title}
        </p>
        {description && (
          <p className="mt-1 text-sm leading-relaxed text-ink-2">
            {description}
          </p>
        )}
        <div className="mt-4 flex flex-col gap-2 md:flex-row md:justify-end">
          <button
            type="button"
            onClick={cancel}
            data-testid="dialog-cancel"
            className="rounded-xl border border-neutral-200 px-4 py-3 text-sm text-neutral-700 hover:bg-hover md:py-1.5 dark:border-white/15 dark:text-neutral-200"
          >
            {cancelLabel}
          </button>
          <button
            ref={primary}
            type="button"
            onClick={() => onAnswer(true)}
            data-testid="dialog-confirm"
            className={`rounded-xl px-4 py-3 text-sm font-medium md:py-1.5 ${
              destructive
                ? "bg-red-600 text-white hover:bg-red-500"
                : "bg-accent text-accent-fg hover:bg-accent/85"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
