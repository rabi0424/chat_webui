import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 画像として表示済みのURLが、本文にも裸で置かれている場合はそれを消す。
 *
 * Poeの画像生成ボットは `![...](url)` と、同じURLの行を続けて返すため、
 * そのままだと画像の下に長いリンクが重複して出る。保存内容には手を
 * 付けず、表示のときだけ落とす（URL単独の行に限るので、文中のリンクや
 * 別のURLは残る）。
 */
function stripDuplicateImageUrls(markdown: string): string {
  const shown = new Set<string>();
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
    shown.add(m[1]);
  }
  if (shown.size === 0) return markdown;

  const kept = markdown.split("\n").filter((line) => {
    const text = line.trim();
    if (!text) return true;
    if (shown.has(text)) return false;
    // [url](url) や [表示名](url) の形で置かれることもある
    const link = /^\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)$/.exec(text);
    return !(link && shown.has(link[1]));
  });

  // 行を落とした跡の空行が続かないようにする
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm prose-neutral sm:prose-base dark:prose-invert max-w-none break-words prose-pre:overflow-x-auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {stripDuplicateImageUrls(children)}
      </ReactMarkdown>
    </div>
  );
}
