/**
 * 宛先が効いていることの説明（`@ボット名` が採用されたときだけ出す）。
 *
 * 色分けだけでは「宛先として採用された」ことは分かっても、**どのモデルで
 * 返ってくるか**が分からない。入力欄のチップに出ているモデルとは違うものが
 * 使われるので、その場で見せておく。
 *
 * コンポーザーと編集欄の両方で出す。編集欄には色分けの帯が無い（本文の
 * 裏に同じ字送りの板を敷く作りで、利用者が縦に伸ばせる欄では帯だけが
 * ずれる）ので、あちらでは**ここが唯一の手がかり**になる。
 */
import type { BotRow } from "../../lib/db.server";
import type { ModelInfo } from "../../lib/openrouter.server";
import { shortModelName } from "../ModelPicker";

export function MentionAddressee({
  bot,
  models,
  onClear,
  className = "",
}: {
  bot: BotRow;
  /** 添えるモデル名を引くため。 */
  models: ModelInfo[];
  /** 宛先の指定を本文から取り除く。 */
  onClear: () => void;
  /** 置き場所ごとの余白。 */
  className?: string;
}) {
  const model = models.find((m) => m.id === bot.model_id);
  return (
    <p className={`flex items-center gap-1.5 text-xs ${className}`}>
      <span aria-hidden>{bot.icon}</span>
      <span className="font-medium text-accent-ink">{bot.name}</span>
      <span className="min-w-0 truncate text-ink-3">
        宛て・{shortModelName(model, bot.model_id)}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="shrink-0 rounded px-1 text-ink-3 hover:bg-hover hover:text-ink-2"
      >
        解除
      </button>
    </p>
  );
}
