/**
 * GitHub の警告ブロック（Alerts）を、印の付いた `<div>` へ置き換える remark プラグイン。
 *
 *   > [!NOTE]
 *   > 補足の説明。
 *
 * GFM の仕様には入っていないため remark-gfm では解釈されず、そのままだと
 * ただの引用ブロックに潰れてしまう。モデルはこの記法をよく使うので、
 * ここで種類を取り出して `md-alert md-alert-note` のようなクラスに変換し、
 * 見出しと配色は Markdown.tsx / app.css 側で付ける。
 *
 * 変換は mdast の段階で行い、`hName` / `hProperties` でHTML化のときの
 * タグとクラスだけを指定する（生HTMLを挟まないのでサニタイズと衝突しない）。
 */
import type { Blockquote, Paragraph, Root, RootContent, Text } from "mdast";

export const ALERT_TYPES = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

/**
 * 目印の行。GitHub は「1行目が目印だけ」であることを求めるが、モデルは
 * `> [!NOTE] 本文` と続けて書くこともあるので、その形も受け付ける。
 */
const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(\r?\n|$)?/i;

/** クラス名から種類を取り出す（描画側で使う）。 */
export function alertTypeOf(className: unknown): AlertType | null {
  const names = Array.isArray(className)
    ? className.map(String)
    : String(className ?? "").split(/\s+/);
  for (const name of names) {
    const type = name.startsWith("md-alert-") ? name.slice(9) : null;
    if (type && (ALERT_TYPES as readonly string[]).includes(type)) {
      return type as AlertType;
    }
  }
  return null;
}

function firstText(paragraph: Paragraph): Text | null {
  const first = paragraph.children[0];
  return first?.type === "text" ? first : null;
}

/** 引用ブロックが警告ブロックなら印を付ける。そうでなければ何もしない。 */
function markAlert(node: Blockquote): void {
  const paragraph = node.children[0];
  if (paragraph?.type !== "paragraph") return;
  const text = firstText(paragraph);
  if (!text) return;

  const match = MARKER.exec(text.value);
  if (!match) return;

  const type = match[1].toLowerCase() as AlertType;
  text.value = text.value.slice(match[0].length);

  // 目印だけの行だった場合、空になったテキストと直後の改行を取り除く。
  // （remark-breaks より先に走るので改行はまだ text の中にあるが、
  //   順番が変わっても困らないよう break ノードの形も見ておく）
  if (!text.value) {
    paragraph.children.shift();
    if (paragraph.children[0]?.type === "break") paragraph.children.shift();
    if (paragraph.children.length === 0) node.children.shift();
  }

  node.data = {
    ...node.data,
    hName: "div",
    hProperties: {
      ...(node.data as { hProperties?: Record<string, unknown> })?.hProperties,
      className: ["md-alert", `md-alert-${type}`],
    },
  };
}

function walk(node: Root | RootContent): void {
  if (!("children" in node) || !Array.isArray(node.children)) return;
  for (const child of node.children as RootContent[]) {
    if (child.type === "blockquote") markAlert(child);
    walk(child);
  }
}

/** `> [!NOTE]` などの引用ブロックを警告ブロックとして印付けする。 */
export function remarkAlert() {
  return (tree: Root) => walk(tree);
}
