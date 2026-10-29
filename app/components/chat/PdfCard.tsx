/**
 * PDF の添付の札（入力欄・編集欄・発言の3か所で同じ見た目）。
 *
 * 画像の添付は縮小した絵を並べるが、PDF は `<img>` では描けない——
 * 見本の URL を img に渡すと壊れた画像の印が出るだけで、何を添えたのか
 * 分からない。名前と大きさを出す。
 */
import { formatBytes } from "../../lib/image";
import { IconDocument } from "../icons";

/** 札の外枠の大きさ。画像の枠（h-16 w-16）と高さを揃え、横に長くする。 */
export const PDF_TILE = "h-16 w-44";

export function PdfCardBody({
  name,
  size,
}: {
  name: string | null;
  size: number;
}) {
  return (
    <span className="flex h-full w-full min-w-0 items-center gap-2 px-2.5 text-left">
      <IconDocument className="h-7 w-7 shrink-0 text-red-500 dark:text-red-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-ink">
          {name || "PDF"}
        </span>
        <span className="block text-[11px] tabular-nums text-ink-3">
          PDF{size > 0 ? `・${formatBytes(size)}` : ""}
        </span>
      </span>
    </span>
  );
}
