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
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconChevronUpDown,
  IconCopy,
} from "./icons";

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
 * 表記の揺れをそろえる。
 *
 * モデルが書く表は、全角の数字も、引き算の記号（U+2212）も、
 * 全角のハイフンも混ざる。見た目は同じでも符号や桁が読めなくなるので、
 * 数として見る前に半角へ寄せる。
 */
function normalizeDigits(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u2212\uFF0D\u2010-\u2015]/g, "-")
    .replace(/[．]/g, ".")
    .replace(/[\s,，]/g, "");
}

/**
 * そのセルが「数そのもの」か。数なら値、そうでなければ null。
 *
 * 以前は文字列のどこかにある数を拾っていた（「約 5 件」→ 5）。便利に
 * 見えて、実際には次のように壊れる：
 *
 * - 「v2.0」→ 2、「2024-01-15」→ 2024（日付が年だけで並ぶ）
 * - 「商品-5」→ -5（語中のハイフンを符号として読む）
 *
 * 単位や前置きが付いた数（「1,234円」「約5件」）は拾いたいので、
 * **数の前後にあるものが記号・単位だけ**であることを確かめる。数が
 * 2つ以上あるものは数として扱わない（日付や版番号がこれに当たる）。
 */
export function numeric(text: string): number | null {
  const body = normalizeDigits(text);
  if (body === "") return null;
  const matches = body.match(/-?\d+(?:\.\d+)?/g);
  // 数が複数あるなら、どれを代表にしても恣意的になる（日付・版番号）
  if (!matches || matches.length !== 1) return null;
  const n = Number(matches[0]);
  if (!Number.isFinite(n)) return null;
  // 数の前に文字が付く場合、そのハイフンは符号ではない（「商品-5」）
  const at = body.indexOf(matches[0]);
  if (matches[0].startsWith("-") && at > 0) return Math.abs(n);
  return n;
}

/**
 * 列ごとに比べ方を先に決める。
 *
 * セルごとに「数なら数として、そうでなければ文字として」比べていたため、
 * 数と文字が混ざる列では比べ方が組み合わせによって変わり、**並びが
 * 一意に決まらなかった**（同じ列でも、どの2つを比べるかで大小が入れ替わる）。
 *
 * 列の値がすべて数のときだけ数として比べ、ひとつでも数でないものが
 * あれば列ぜんぶを文字として比べる。文字の比較は numeric: true を付けて
 * おくと「項目2」と「項目10」も期待どおりに並ぶ。
 */
export function comparatorFor(
  values: string[],
): (a: string, b: string) => number {
  const nonEmpty = values.filter((v) => v.trim() !== "");
  const allNumeric =
    nonEmpty.length > 0 && nonEmpty.every((v) => numeric(v) !== null);

  if (allNumeric) {
    return (a, b) => {
      // 空欄は値が無いので、昇順でも降順でも末尾に置く
      const na = numeric(a);
      const nb = numeric(b);
      if (na === null) return nb === null ? 0 : 1;
      if (nb === null) return -1;
      return na - nb;
    };
  }
  return (a, b) => {
    if (a.trim() === "") return b.trim() === "" ? 0 : 1;
    if (b.trim() === "") return -1;
    return a.localeCompare(b, "ja", { numeric: true });
  };
}

/**
 * タブ区切りで貼るときの1マス。
 *
 * セルの中にタブや改行が入っていると、そのまま繋げた文字列は表計算側で
 * 別のマス・別の行として読まれ、**そこから先の列が丸ごとずれる**。
 * モデルが書く表では、セル内改行（`<br>` の代わり）も箇条書きも珍しくない。
 *
 * 区切りを含むマスは二重引用符で囲み、中の引用符は2つ重ねる（CSV と
 * 同じ流儀）。Excel も Google スプレッドシートも、タブ区切りの貼り付けで
 * この囲みを解釈する。
 */
export function tsvCell(text: string): string {
  if (!/[\t\r\n"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
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
    const column = bodyText.map((r) => r[sort.column] ?? "");
    const compare = comparatorFor(column);
    return [...base].sort((a, b) => {
      const d = compare(column[a], column[b]);
      // 同じ値のときは元の並びを保つ
      return d !== 0 ? (sort.desc ? -d : d) : a - b;
    });
  }, [bodyText, sort]);

  const tsv = useMemo(() => {
    const line = (cells: string[]) => cells.map(tsvCell).join("\t");
    const lines = headText.length ? [line(headText)] : [];
    for (const i of order) lines.push(line(bodyText[i]));
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
                    /*
                      見出しは th なので、そのままではキーボードの
                      対象にならない（Tab で辿り着けず、Enter も効かない）。
                      押せるものとして扱えるようにする。
                    */
                    tabIndex: 0,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle(i);
                      }
                    },
                    title: "クリックで並べ替え",
                    className: "md-table-sortable",
                  } as Record<string, unknown>,
                  <>
                    {th.props.children}
                    {/*
                      並べ替えの印は文字ではなくアイコンで描く。「↕」などの
                      記号は端末によって絵文字として色付きで表示され、
                      見出しの中で浮いてしまうため。
                    */}
                    <span aria-hidden className="md-table-arrow">
                      {sort?.column === i ? (
                        sort.desc ? (
                          <IconChevronDown className="h-3 w-3" />
                        ) : (
                          <IconChevronUp className="h-3 w-3" />
                        )
                      ) : (
                        <IconChevronUpDown className="h-3 w-3" />
                      )}
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
