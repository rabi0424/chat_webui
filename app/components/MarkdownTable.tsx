import {
  Children,
  cloneElement,
  isValidElement,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Element, ElementContent } from "hast";
import { IconCheck, IconCopy } from "./icons";

/**
 * 表。横スクロールに加えて、列の並べ替えと表全体のコピーを付ける。
 *
 * 並べ替えは「表示のしかた」を変えるだけで、本文（保存内容）には触らない。
 * モデルが返す表は並び順まで整っていないことが多く、数値の列を大きい順に
 * 見たいだけ、という場面がよくあるため。
 *
 * 中身は react-markdown が描いた要素をそのまま並べ替える。文字列に
 * 落とし直すと、セルの中の強調・リンク・コード・数式が消えてしまう。
 * 並べ替えの基準に使う文字だけを hast から取り出す。
 */

function cellText(node: ElementContent | Element | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map(cellText).join("");
  return "";
}

function sectionRows(node: Element | undefined, tag: "thead" | "tbody"): Element[] {
  const section = node?.children.find(
    (c): c is Element => c.type === "element" && c.tagName === tag,
  );
  return (
    section?.children.filter(
      (c): c is Element => c.type === "element" && c.tagName === "tr",
    ) ?? []
  );
}

function cellsOf(row: Element | undefined): Element[] {
  return (
    row?.children.filter(
      (c): c is Element =>
        c.type === "element" && (c.tagName === "td" || c.tagName === "th"),
    ) ?? []
  );
}

type WithChildren = { children?: ReactNode };

/** React 側の子から、目的のタグの要素だけを順番どおりに取り出す。 */
function elements(
  children: ReactNode,
  tag: string,
): ReactElement<WithChildren>[] {
  return Children.toArray(children).filter(
    (c): c is ReactElement<WithChildren> => isValidElement(c) && c.type === tag,
  );
}

/**
 * 数として比べられる値。桁区切りや単位が付いていても、含まれる数で比べる
 * （「1,234円」「約 5 件」など、モデルの表はきれいな数値とは限らない）。
 */
function numeric(text: string): number | null {
  const body = text.replace(/[\s,，]/g, "");
  if (!/\d/.test(body)) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(body);
  return m ? Number(m[0]) : null;
}

function compare(a: string, b: string): number {
  const na = numeric(a);
  const nb = numeric(b);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  return a.localeCompare(b, "ja");
}

type Sort = { column: number; desc: boolean } | null;

function CopyTableButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="表をコピー"
      title="表をタブ区切りでコピー（表計算ソフトにそのまま貼れます）"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // クリップボード不許可時は何もしない
        }
      }}
      className="rounded p-1 text-neutral-400 opacity-0 transition-opacity group-hover/table:opacity-100 focus-visible:opacity-100 hover:bg-neutral-200 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
    >
      {copied ? (
        <IconCheck className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <IconCopy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export function MarkdownTable({
  node,
  children,
}: {
  node?: Element;
  children?: ReactNode;
}) {
  const [sort, setSort] = useState<Sort>(null);

  // 並べ替えとコピーに使う文字は hast から、描くものは React の子から取る
  const headText = useMemo(
    () => cellsOf(sectionRows(node, "thead")[0]).map(cellText),
    [node],
  );
  const bodyText = useMemo(
    () => sectionRows(node, "tbody").map((row) => cellsOf(row).map(cellText)),
    [node],
  );

  const thead = elements(children, "thead")[0];
  const tbody = elements(children, "tbody")[0];
  const headRow = thead ? elements(thead.props.children, "tr")[0] : undefined;
  const headCells = headRow ? elements(headRow.props.children, "th") : [];
  const bodyRows = tbody ? elements(tbody.props.children, "tr") : [];

  /** 表示する行の並び（元の行番号）。 */
  const order = useMemo(() => {
    const base = bodyText.map((_, i) => i);
    if (!sort) return base;
    return [...base].sort((a, b) => {
      const d = compare(bodyText[a][sort.column] ?? "", bodyText[b][sort.column] ?? "");
      // 同じ値のときは元の並びを保つ
      return d !== 0 ? (sort.desc ? -d : d) : a - b;
    });
  }, [bodyText, sort]);

  const tsv = useMemo(() => {
    const lines = headText.length ? [headText.join("\t")] : [];
    for (const i of order) lines.push(bodyText[i].join("\t"));
    return lines.join("\n");
  }, [headText, bodyText, order]);

  // 見出しと本体が揃っていない表は、並べ替えのしようがないのでそのまま出す
  const sortable =
    headCells.length > 0 &&
    bodyRows.length > 1 &&
    bodyRows.length === bodyText.length &&
    headCells.length === headText.length;

  if (!sortable) {
    return (
      <div className="group/table -mx-1 overflow-x-auto px-1">
        <table>{children}</table>
      </div>
    );
  }

  const toggle = (column: number) =>
    setSort((prev) =>
      prev?.column === column
        ? prev.desc
          ? null // 3回目で元の並びに戻す
          : { column, desc: true }
        : { column, desc: false },
    );

  return (
    <div className="group/table md-table">
      <div className="flex justify-end">
        <CopyTableButton text={tsv} />
      </div>
      <div className="-mx-1 overflow-x-auto px-1">
        <table>
          <thead>
            <tr>
              {headCells.map((th, i) =>
                cloneElement(
                  th,
                  {
                    key: i,
                    "aria-sort":
                      sort?.column === i
                        ? sort.desc
                          ? "descending"
                          : "ascending"
                        : "none",
                    onClick: () => toggle(i),
                    title: "クリックで並べ替え",
                    className: "md-table-sortable",
                  } as Record<string, unknown>,
                  <>
                    {th.props.children}
                    <span aria-hidden className="md-table-arrow">
                      {sort?.column === i ? (sort.desc ? "▼" : "▲") : "↕"}
                    </span>
                  </>,
                ),
              )}
            </tr>
          </thead>
          <tbody>{order.map((i) => cloneElement(bodyRows[i], { key: i }))}</tbody>
        </table>
      </div>
    </div>
  );
}
