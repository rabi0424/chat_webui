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

import { notifyChanged, readRaw, usePersisted, writeRaw } from "./persisted";

/**
 * 畳むしきい値。これ以上の文字数か行数なら畳む（0 はその条件では畳まない。
 * 両方 0 なら畳まない）。
 *
 * 打ち心地の好みなので端末ごと（localStorage）。スマホでは短めに、
 * Mac では長めに、という使い分けができる。設定画面の「入力欄」で変える。
 */
export interface PasteThreshold {
  chars: number;
  lines: number;
}

export const DEFAULT_PASTE_THRESHOLD: PasteThreshold = { chars: 1000, lines: 12 };
export const PASTE_CHARS_RANGE = { min: 0, max: 100_000 };
export const PASTE_LINES_RANGE = { min: 0, max: 1000 };
export const PASTE_THRESHOLD_STORAGE_KEY = "chat-webui:paste-threshold";

/** 範囲に収めた整数（範囲外や数でないものは既定へ）。 */
function clampInt(v: unknown, range: { min: number; max: number }, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(n)));
}

/*
 * 読んだ値は生の文字列ごとに使い回す。useSyncExternalStore は同じ
 * スナップショットには同じ参照を返す必要があり、毎回新しいオブジェクトを
 * 作ると描画が止まらなくなる。
 */
let cached: { raw: string | null; value: PasteThreshold } | null = null;

export function readPasteThreshold(): PasteThreshold {
  const raw = readRaw(PASTE_THRESHOLD_STORAGE_KEY);
  if (cached && cached.raw === raw) return cached.value;
  let value = DEFAULT_PASTE_THRESHOLD;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PasteThreshold>;
      value = {
        chars: clampInt(parsed.chars, PASTE_CHARS_RANGE, DEFAULT_PASTE_THRESHOLD.chars),
        lines: clampInt(parsed.lines, PASTE_LINES_RANGE, DEFAULT_PASTE_THRESHOLD.lines),
      };
    } catch {
      // 壊れていれば既定
    }
  }
  cached = { raw, value };
  return value;
}

export function savePasteThreshold(next: PasteThreshold): void {
  writeRaw(
    PASTE_THRESHOLD_STORAGE_KEY,
    JSON.stringify({
      chars: clampInt(next.chars, PASTE_CHARS_RANGE, DEFAULT_PASTE_THRESHOLD.chars),
      lines: clampInt(next.lines, PASTE_LINES_RANGE, DEFAULT_PASTE_THRESHOLD.lines),
    }),
  );
  notifyChanged(PASTE_THRESHOLD_STORAGE_KEY);
}

/** いまのしきい値を購読する（サーバー側では既定）。 */
export function usePasteThreshold(): PasteThreshold {
  return usePersisted(
    PASTE_THRESHOLD_STORAGE_KEY,
    readPasteThreshold,
    DEFAULT_PASTE_THRESHOLD,
  );
}

export interface CollapsedPaste {
  /** 札の番号（1から。同じ入力欄の中で一意）。 */
  n: number;
  text: string;
}

export function shouldCollapsePaste(
  text: string,
  threshold: PasteThreshold = DEFAULT_PASTE_THRESHOLD,
): boolean {
  if (threshold.chars > 0 && text.length >= threshold.chars) return true;
  return threshold.lines > 0 && countLines(text) >= threshold.lines;
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
