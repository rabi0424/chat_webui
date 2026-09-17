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

import { hostLabel } from "./page-url";
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
  /** 札の番号（1から。同じ入力欄の中で一意。貼り付けとページで通し番号）。 */
  n: number;
  text: string;
  /**
   * 貼られたリンクから取り込んだページなら、その元のURL。
   *
   * **この値は後から変えない。** 札の文字（`[ページ #1: example.com]`）を
   * ここから作っているので、転送を追った先のホストに差し替えると、
   * 本文に入っている札と食い違って送るときに戻らなくなる。
   * 実際に読んだ先は finalUrl に持つ。
   */
  url?: string;
  /** 転送を追い終わった先（画面とモデルへはこちらを見せる）。 */
  finalUrl?: string;
  /** ページの見出し。 */
  title?: string;
  /**
   * 落とされた（選ばれた）ファイルなら、そのファイル名。
   *
   * url と同じく**後から変えない**——札の文字をここから作っている。
   */
  file?: string;
  /** 取り込みの進み具合。貼り付け（url 無し）では使わない。 */
  status?: "loading" | "ready" | "error";
  /** 取り込めなかった理由（status === "error" のとき）。 */
  error?: string;
  /** 長さの上限で切ったか。 */
  truncated?: boolean;
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

/**
 * 入力欄に置く札。
 *
 * ページの札にホスト名を入れて行数を入れないのは、**札の文字が
 * 後から変わらないようにする**ため。取り込みは貼った瞬間には
 * 終わっておらず、行数を入れると読み終えた時点で札が別の文字に
 * なる——本文に入れた札と食い違い、送るときに中身へ戻らない。
 */
export function pasteToken(p: CollapsedPaste): string {
  if (p.file) return `[ファイル #${p.n}: ${p.file}]`;
  if (p.url) return `[ページ #${p.n}: ${hostLabel(p.url)}]`;
  return `[貼り付け #${p.n}: ${countLines(p.text)}行]`;
}

/**
 * 札を見つける。番号を取り出せるように括る。
 *
 * 貼り付け・ページ・ファイルの3種類を**1つの正規表現で**見る。分けて
 * 書くと、片方だけを見る場所（本文に残っている札を数えるところなど）が
 * 生まれ、もう片方が「本文から消えた」とみなされて黙って捨てられる。
 */
const TOKEN_RE =
  /\[(?:貼り付け #(\d+): \d+行|(?:ページ|ファイル) #(\d+): [^\]\n]*)\]/g;

/** 見つけた札の番号（どちらの形でも同じように取れる）。 */
function tokenNumber(m: RegExpMatchArray): number {
  return Number(m[1] ?? m[2]);
}

/** 本文に残っている札の番号（順不同・重複なし）。 */
export function pasteNumbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(TOKEN_RE)) out.add(tokenNumber(m));
  return out;
}

/** 次の札の番号。消した番号は使い回さない（前の貼り付けと紛れないように）。 */
export function nextPasteNumber(pastes: CollapsedPaste[]): number {
  return pastes.reduce((max, p) => Math.max(max, p.n), 0) + 1;
}

/** 選択範囲を差し替える。キャレットは差し込んだ文字の直後。 */
export function insertText(
  text: string,
  selection: { start: number; end: number },
  insert: string,
): { text: string; caret: number } {
  const before = text.slice(0, selection.start);
  const after = text.slice(selection.end);
  return { text: before + insert + after, caret: before.length + insert.length };
}

/** 選択範囲を札で置き換える。キャレットは札の直後。 */
export function insertPasteToken(
  text: string,
  selection: { start: number; end: number },
  paste: CollapsedPaste,
): { text: string; caret: number } {
  return insertText(text, selection, pasteToken(paste));
}

/** 取り込んだページの囲み。 */
export const PAGE_OPEN = "［取り込んだページ ここから］";
export const PAGE_CLOSE = "［取り込んだページ ここまで］";

/** 読み込んだファイルの囲み。 */
export const FILE_OPEN = "［取り込んだファイル ここから］";
export const FILE_CLOSE = "［取り込んだファイル ここまで］";

/**
 * 中身に入っている囲みの印を、囲みとして読めない形に均す。
 *
 * **ページとファイルの両方を均す。** 片方だけにすると、取り込んだ
 * ページの中に `［取り込んだファイル ここまで］` と書いてあるだけで、
 * その先に続く文章が囲みの外に出たように読める。
 */
function neutralizeMarks(text: string): string {
  return text.replace(
    /［取り込んだ(ページ|ファイル) (ここから|ここまで)］/g,
    "[取り込んだ$1 $2]",
  );
}

/**
 * 札が本文に戻るときの中身。
 *
 * ページは、どこから取ったものかが分かる囲みに入れて渡す。素の文章
 * として混ぜると、モデルには利用者が書いた指示と区別が付かない
 * ——「このページの言うとおりにして」と読まれる余地を残さない。
 *
 * 囲みを**文字で**書くのは、送った本文がそのまま画面にも出るため。
 * `<page …>` のようなタグにすると、本文の消毒が知らない要素として
 * 落とすので、**自分の発言なのに囲みが見えない**（どこからが取り
 * 込んだ文章なのか、後から読んで分からなくなる）。
 *
 * まだ読み終えていない／読めなかったページはリンクのままにする。
 * 空の囲みを渡すと、モデルは「中身の無いページ」を読んだことにして
 * 答えてしまう。
 *
 * ファイルも同じ理由で囲む（ファイル名を添える）。**貼り付けだけは
 * 囲まない**——利用者が自分で打った・写した文であって、他所から
 * 持ってきた文書ではない。
 */
export function pasteBody(p: CollapsedPaste): string {
  if (p.file) {
    return `${FILE_OPEN}${p.file}\n${neutralizeMarks(p.text)}\n${FILE_CLOSE}`;
  }
  if (!p.url) return p.text;
  if (p.status !== "ready" || p.text.trim() === "") return p.url;
  // 読んだ先（転送のあと）を書く。短縮URLのままでは参照できない
  const head = p.title ? `${p.title} — ${p.finalUrl ?? p.url}` : (p.finalUrl ?? p.url);
  return `${PAGE_OPEN}${head}\n${neutralizeMarks(p.text)}\n${PAGE_CLOSE}`;
}

/**
 * 札を本文に戻す（送るとき・「展開」を押したとき）。
 * 対応する貼り付けが無い札はそのまま残す（作った覚えの無い文字を消さない）。
 */
export function expandPastes(text: string, pastes: CollapsedPaste[]): string {
  const byN = new Map(pastes.map((p) => [p.n, p]));
  return text.replace(TOKEN_RE, (whole, ...args) => {
    const n = Number(args[0] ?? args[1]);
    const found = byN.get(n);
    return found ? pasteBody(found) : whole;
  });
}

/** 1つの札だけを展開する。 */
export function expandOnePaste(text: string, paste: CollapsedPaste): string {
  return text.split(pasteToken(paste)).join(pasteBody(paste));
}

/** 1つの札を別の文字に置き換える。 */
export function replacePasteToken(
  text: string,
  paste: CollapsedPaste,
  replacement: string,
): string {
  return text.split(pasteToken(paste)).join(replacement);
}

/**
 * 1つの札を取り除く（貼り付けごと捨てる）。
 *
 * ページの札は**リンクの文字だけ残す**。取り込みをやめたいだけの
 * ことがほとんどで、貼ったリンクまで消えると打ち直しになる。
 */
export function removePasteToken(text: string, paste: CollapsedPaste): string {
  return replacePasteToken(text, paste, paste.url ?? "");
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
    out.push({ start, end: start + m[0].length, n: tokenNumber(m) });
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
