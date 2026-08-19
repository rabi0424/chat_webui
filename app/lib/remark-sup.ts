/**
 * `^2^` のような上付き文字を `<sup>` にする remark プラグイン。
 *
 * 単位（m^2^）や注記番号のように、数式を持ち出すほどでもない場面で使われる。
 * 化学式のような下付きは `~2~` で書く流儀もあるが、こちらは採用しない——
 * `~` は1個で発火するため `~/.config` と `~/bin` が同じ行にあるだけで
 * 途中が下付きになってしまう（GFM の `~~取り消し線~~` とも紛らわしい）。
 * 下付きが要る場面のほとんどは化学式なので、そちらは KaTeX の mhchem
 * （`$\ce{H2O}$`）に任せる。
 *
 * 変換の対象は本文のテキストだけ。コード（`inlineCode` / `code`）と
 * 数式（`inlineMath` / `math`）は mdast 上で別のノードなので、そもそも
 * ここを通らない。
 */
import type { Nodes, Parents, PhrasingContent, Root, Text } from "mdast";

/**
 * `^` … `^`。中身は改行と `^` を含まず、両端が空白でないこと。
 * 「2^10 と 3^5」のように `^` が単独で現れる文を巻き込まないための条件。
 */
const SUP = /\^([^\s^](?:[^^\n]*[^\s^])?)\^/g;

/** 上付きにするノード。HTML化のときだけ `<sup>` になる。 */
function sup(value: string): PhrasingContent {
  return {
    type: "emphasis",
    data: { hName: "sup" },
    children: [{ type: "text", value }],
  };
}

/** テキストを `^…^` で切り分ける。対象が無ければ null（作り直さない）。 */
function split(node: Text): PhrasingContent[] | null {
  SUP.lastIndex = 0;
  if (!SUP.test(node.value)) return null;

  const out: PhrasingContent[] = [];
  let last = 0;
  SUP.lastIndex = 0;
  for (let m = SUP.exec(node.value); m; m = SUP.exec(node.value)) {
    if (m.index > last) {
      out.push({ type: "text", value: node.value.slice(last, m.index) });
    }
    out.push(sup(m[1]));
    last = m.index + m[0].length;
  }
  if (last < node.value.length) {
    out.push({ type: "text", value: node.value.slice(last) });
  }
  return out;
}

/** 中の文字を触ってはいけないノード（リンク先や画像の説明など）。 */
const SKIP = new Set(["inlineCode", "code", "math", "inlineMath", "html"]);

function walk(node: Nodes): void {
  if (!("children" in node) || !Array.isArray(node.children)) return;

  const parent = node as Parents;
  const children: PhrasingContent[] = [];
  let changed = false;

  for (const child of parent.children as PhrasingContent[]) {
    if (SKIP.has(child.type)) {
      children.push(child);
      continue;
    }
    if (child.type === "text") {
      const parts = split(child);
      if (parts) {
        children.push(...parts);
        changed = true;
        continue;
      }
      children.push(child);
      continue;
    }
    walk(child);
    children.push(child);
  }

  if (changed) parent.children = children as typeof parent.children;
}

/** `^…^` を上付きにする。 */
export function remarkSup() {
  return (tree: Root) => walk(tree);
}
