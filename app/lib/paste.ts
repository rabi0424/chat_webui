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

/** 本文にある札の位置（開始・終了・番号）。 */
export function pasteTokenRanges(
  text: string,
): { start: number; end: number; n: number }[] {
  const out: { start: number; end: number; n: number }[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, n: Number(m[1]) });
  }
  return out;
}

/**
 * 札は1つの塊として扱う。編集が札の一部にかかったら、札ごと取り除く。
 *
 * 札は文字なので、そのままだと1文字消しただけで「ただの文字列」に
 * 戻り、貼り付けとの結び付きが切れる（送るときに戻らない）。編集の
 * 前後の本文から変わった範囲を求め、札に食い込んでいれば札全体を
 * 範囲に含め直す。札の端に文字を足す・端の外側を消すのは、札に
 * 触れていないので何もしない。
 *
 * 直す必要が無ければ null。
 */
export function keepPasteTokensWhole(
  before: string,
  after: string,
): { text: string; caret: number } | null {
  const tokens = pasteTokenRanges(before);
  if (tokens.length === 0) return null;
  // 変わった範囲（before の座標）。共通の前置きと後置きを除いた残り
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(before.length, after.length) - prefix;
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  let start = prefix;
  let end = before.length - suffix;
  const inserted = after.slice(prefix, after.length - suffix);

  let touched = false;
  for (const t of tokens) {
    // 札に食い込んでいる（端に触れているだけでは無い）
    if (start < t.end && end > t.start) {
      touched = true;
      start = Math.min(start, t.start);
      end = Math.max(end, t.end);
    }
  }
  if (!touched) return null;
  const text = before.slice(0, start) + inserted + before.slice(end);
  // 札ごと選んで消した・置き換えたときは、もう望みの形になっている
  if (text === after) return null;
  return { text, caret: start + inserted.length };
}

/**
 * キャレット（選択範囲）が札の中に入らないよう、端へ寄せる。
 * 点なら近いほうの端へ、範囲なら外側へ広げる。動かす必要が無ければ null。
 */
export function snapSelectionOutsideTokens(
  text: string,
  selection: { start: number; end: number },
): { start: number; end: number } | null {
  let { start, end } = selection;
  let moved = false;
  for (const t of pasteTokenRanges(text)) {
    const inside = (pos: number) => pos > t.start && pos < t.end;
    if (start === end && inside(start)) {
      const near = start - t.start <= t.end - start ? t.start : t.end;
      start = end = near;
      moved = true;
      continue;
    }
    if (inside(start)) {
      start = t.start;
      moved = true;
    }
    if (inside(end)) {
      end = t.end;
      moved = true;
    }
  }
  return moved ? { start, end } : null;
}
