/**
 * 確定した本文を「もう変わらない塊」へ切り分ける。
 *
 * 生成中は本文が数十msおきに伸びる。確定ぶんを1つの Markdown として
 * 描いていると、届くたびに全体を解析し直すことになり、長い応答ほど
 * 1回あたりの描き直しが重くなる。塊ごとに分けて memo に載せれば、
 * 増えた末尾の塊だけを解析すれば済む。
 *
 * ただし切る場所を間違えると見え方が変わる。マークダウンには空行を
 * またいで1つになる構造があるため、切ってよいのは「前後を別々に
 * 解析しても同じ結果になる」と言い切れる境目だけに絞ってある。
 * 判断のつかないもの（脚注・参照リンクの定義がある文書）は、
 * まるごと1つとして返す。
 *
 * 返した塊をそのままつなげると元の文字列に戻る（区切りを足さない）。
 */

/** 行の種類。境目を切ってよいかは、前後の組み合わせで決める。 */
type Kind = "plain" | "list" | "quote" | "html" | "indented";

function kindOf(line: string): Kind {
  if (/^ {0,3}>/.test(line)) return "quote";
  if (/^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(line)) return "list";
  if (/^ {0,3}</.test(line)) return "html";
  if (/^(?: {4}|\t)/.test(line)) return "indented";
  return "plain";
}

/**
 * 前の塊と、次の塊の最初の行のあいだで切ってよいか。
 *
 * - 字下げで始まる行は、箇条書きの続きかもしれない（切ると項目から外れる）
 * - 生HTMLは空行をまたいで閉じることがある
 * - 箇条書きどうしは1つのリスト（切ると番号が振り直され、間隔も変わる）。
 *   前の塊が箇条書きで終わっているとは限らない——項目の続きの段落が
 *   後ろに付いていることがあるので、塊の中に箇条書きがあったかで見る
 * - 引用どうしも、続きとして読まれることがある
 */
function canSplit(
  prev: { tail: string; hasList: boolean },
  nextHead: string,
): boolean {
  if (/^\s/.test(nextHead)) return false;
  const a = kindOf(prev.tail);
  const b = kindOf(nextHead);
  if (a === "html" || b === "html") return false;
  if (b === "indented") return false;
  if (b === "list" && (a === "list" || prev.hasList)) return false;
  if (a === "quote" && b === "quote") return false;
  return true;
}

/** 脚注や参照リンクの定義。本文と離れた場所にあるので切り離せない。 */
function mustKeepWhole(src: string): boolean {
  return /^ {0,3}\[[^\]\n]+\]:\s/m.test(src);
}

function firstLine(lines: string[]): string {
  return lines.find((l) => l.trim() !== "") ?? "";
}

function lastLine(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") return lines[i];
  }
  return "";
}

export function splitBlocks(src: string): string[] {
  if (!src) return [];
  if (mustKeepWhole(src)) return [src];

  const lines = src.split("\n");
  /** 塊ごとの行。空行は直前の塊の末尾に付ける（つなげると元に戻る）。 */
  const blocks: string[][] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let math = false;
  let afterBlank = false;

  for (const line of lines) {
    if (fence) {
      current.push(line);
      if (new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}\\s*$`).test(line)) {
        fence = null;
      }
      continue;
    }
    if (math) {
      current.push(line);
      if (line.trim() === "$$") math = false;
      continue;
    }

    const isBlank = line.trim() === "";
    if (!isBlank && afterBlank && current.length) {
      blocks.push(current);
      current = [];
    }
    afterBlank = isBlank;

    current.push(line);
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) fence = open[1];
    else if (line.trim() === "$$") math = true;
  }
  if (current.length) blocks.push(current);

  const merged: { lines: string[]; hasList: boolean }[] = [];
  for (const block of blocks) {
    const hasList = block.some((l) => kindOf(l) === "list");
    const prev = merged[merged.length - 1];
    if (
      prev &&
      !canSplit({ tail: lastLine(prev.lines), hasList: prev.hasList }, firstLine(block))
    ) {
      prev.lines.push(...block);
      prev.hasList ||= hasList;
      continue;
    }
    merged.push({ lines: block, hasList });
  }

  return merged.map(({ lines: block }, i) =>
    i === merged.length - 1 ? block.join("\n") : `${block.join("\n")}\n`,
  );
}
