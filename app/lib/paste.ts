/**
 * 長い貼り付けを入力欄で畳む。
 *
 * 数千字を貼ると入力欄が本文で埋まり、前後に書いた依頼が見えなくなる。
 * ChatGPT や Claude はこれをテキストファイルの添付に変える（モデルには
 * ファイルとして渡し、本文には入れない）が、ここでは **見た目だけ畳み、
 * 送るときは本文へそのまま展開する**（Claude Code と同じ）。添付にすると
 * 全文がモデルに入らなくなる上、送ったあと編集もできないという不満が
 * どのアプリにも出ている。
 *
 * 畳んだ貼り付けは入力欄の中で `[貼り付け #1: 42行]` という札に置き換え、
 * 本文は別に持つ。札は文字なので、キャレットの位置に入り、前後に文を
 * 足せる。札を消せば貼り付けも消える（送るときに無いものは無い）。
 */

/** これ以上の文字数か行数なら畳む。 */
export const PASTE_COLLAPSE_CHARS = 1000;
export const PASTE_COLLAPSE_LINES = 12;

export interface CollapsedPaste {
  /** 札の番号（1から。同じ入力欄の中で一意）。 */
  n: number;
  text: string;
}

export function shouldCollapsePaste(text: string): boolean {
  if (text.length >= PASTE_COLLAPSE_CHARS) return true;
  return countLines(text) >= PASTE_COLLAPSE_LINES;
}

export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

/** 入力欄に置く札。 */
export function pasteToken(p: CollapsedPaste): string {
  return `[貼り付け #${p.n}: ${countLines(p.text)}行]`;
}

/** 札を見つける。番号を取り出せるように括る。 */
const TOKEN_RE = /\[貼り付け #(\d+): \d+行\]/g;

/** 本文に残っている札の番号（順不同・重複なし）。 */
export function pasteNumbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(TOKEN_RE)) out.add(Number(m[1]));
  return out;
}

/** 次の札の番号。消した番号は使い回さない（前の貼り付けと紛れないように）。 */
export function nextPasteNumber(pastes: CollapsedPaste[]): number {
  return pastes.reduce((max, p) => Math.max(max, p.n), 0) + 1;
}

/** 選択範囲を札で置き換える。キャレットは札の直後。 */
export function insertPasteToken(
  text: string,
  selection: { start: number; end: number },
  paste: CollapsedPaste,
): { text: string; caret: number } {
  const token = pasteToken(paste);
  const before = text.slice(0, selection.start);
  const after = text.slice(selection.end);
  return { text: before + token + after, caret: before.length + token.length };
}

/**
 * 札を本文に戻す（送るとき・「展開」を押したとき）。
 * 対応する貼り付けが無い札はそのまま残す（作った覚えの無い文字を消さない）。
 */
export function expandPastes(text: string, pastes: CollapsedPaste[]): string {
  const byN = new Map(pastes.map((p) => [p.n, p.text]));
  return text.replace(TOKEN_RE, (whole, n: string) => byN.get(Number(n)) ?? whole);
}

/** 1つの札だけを展開する。 */
export function expandOnePaste(text: string, paste: CollapsedPaste): string {
  return text.split(pasteToken(paste)).join(paste.text);
}

/** 1つの札を取り除く（貼り付けごと捨てる）。 */
export function removePasteToken(text: string, paste: CollapsedPaste): string {
  return text.split(pasteToken(paste)).join("");
}

/** 本文を札とそれ以外に切り分ける（色分けの板が札だけを塗るため）。 */
export function splitByPasteTokens(
  text: string,
): { token: boolean; text: string }[] {
  const out: { token: boolean; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ token: false, text: text.slice(last, at) });
    out.push({ token: true, text: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ token: false, text: text.slice(last) });
  return out;
}
