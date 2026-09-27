/**
 * 生成中のポーリングで、同じ本文を何度も運ばないための道具。
 *
 * 追跡は 400ms ごとに走る。応答の**全文**を毎回返していたので、長い応答ほど
 * 1回あたりが重くなっていた——日本語8,000字を90秒かけて生成すると、本当に
 * 必要なのは 24KB なのに、積分でおよそ 2.7MB を運んでいた計算になる。
 * スマホの回線が前提なので、ここは素直に効く。
 *
 * サーバーは「クライアントが既に持っている長さ」を受け取り、その先だけを返す。
 */
import { isRetryProgress } from "./retry";

/** 本文の長さは UTF-16 の単位で数える（JS の String.length と slice に合わせる）。 */
export interface ContentPayload {
  /** 全文。差分で返したときは undefined。 */
  content?: string;
  /** since 以降の追記分。全文で返したときは undefined。 */
  contentDelta?: string;
  /** サーバーが持っている本文の長さ。継ぎ足した結果の検算に使う。 */
  contentLength: number;
}

/** `?since=` を読む。壊れた値は 0（＝全文を返す）に倒す。 */
export function parseSince(url: string): number {
  const raw = new URL(url).searchParams.get("since");
  if (raw == null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * クライアントへ返す本文を決める。
 *
 * 差分で返してよいのは、**本文が末尾に伸びていくだけ**のあいだに限る。
 * 途中で丸ごと書き換わるものを差分で返すと、継ぎ足した結果が壊れる:
 *   - 「成功するまで生成」の見出しは、進捗を毎秒**書き直す**（伸びない）
 *   - 確定（finalizeGeneration）は、要約やエラー文で本文を置き換えることがある
 * どちらも全文で返す。
 *
 * @param appendOnly 本文が末尾に伸びるだけの状態か（生成中で、見出しでない）
 */
export function contentPayload(
  content: string,
  since: number,
  appendOnly: boolean,
): ContentPayload {
  const contentLength = content.length;
  if (!appendOnly || since <= 0) return { content, contentLength };
  // 手元のほうが長いと言われたら、追記は無い。継ぎ足した結果の長さが
  // 合わなくなるので、クライアント側が気づいて取り直す
  const from = Math.min(since, contentLength);
  return { contentDelta: content.slice(from), contentLength };
}

/**
 * 受け取った本文を組み立てる。
 *
 * @returns 組み立てた全文。食い違っていれば null（呼ぶ側は全文を取り直す）
 */
export function applyContentPayload(
  held: string,
  payload: ContentPayload,
): string | null {
  const full =
    payload.content != null
      ? payload.content
      : held + (payload.contentDelta ?? "");
  // 検算。サーバー側で本文が置き換わっていた（縮んだ・書き直された）場合に
  // ここで気づく。黙って継ぎ足すと、壊れた本文を表示し続けることになる
  return full.length === payload.contentLength ? full : null;
}

/** 札を作るのに要る、パスの1行ぶん（本文を読んだ行でも、読まない行でもよい）。 */
export interface FingerprintRow {
  id: string;
  status?: string | null;
  flushed_at?: number | null;
  /** 本文。読まない経路では、生成中の見出しのときだけ入る。 */
  content?: string | null;
  context_boundary?: number | null;
  sibling_ids?: string[];
  attachments?: { id: string; thumb_at?: number | null }[];
}

/**
 * 生成中の「成功するまで生成」の見出しか。
 *
 * この行の書き込み時刻は、司令役が進捗を打ち直すたび（最初の2分は毎秒）に
 * 動く。数字が変わっていなくても動く——中断の判定（60秒の無更新）のために
 * 生きている印として書くため。
 */
function isLiveProgress(row: FingerprintRow): boolean {
  return row.status === "streaming" && isRetryProgress(row.content ?? "");
}

/**
 * 表示中のパスの指紋。
 *
 * 「成功するまで生成」の追跡は毎秒パスを見に来る。中身が変わっていなければ
 * 304 で済ませ、積み上がった成功の本文を運ばないための札。
 *
 * 見るもの。**どれか1つでも欠けると、変わったのに変わっていないと言って
 * しまう**:
 *   - 行のID: 枝を切り替えるとパスの中身が入れ替わる（件数は同じことがある）
 *   - 状態: 確定した瞬間を捉える（本文が同じでも streaming → done は伝える）
 *   - 最後の書き込み時刻: 生成中の本文が伸びるたび、また確定済みの本文を
 *     差し替えたとき（画像を自前の置き場へ移した。監査 S-7）に動く
 *   - 区切り線・兄弟（ページャ）・添付と縮小版の有無: 画面に出るもの
 *
 * **生成中の見出しだけは書き込み時刻を見ない。** 司令役が毎秒書き直すので、
 * 入れると何も変わっていない1秒ごとに札が変わり、最初の2分はほぼ一度も
 * 304 にならなかった。見出しの進捗（成功の数など）は札に入れず、304 に
 * 添えて別に返す（`RUN_PROGRESS_HEADER`）。進捗が1つ動くたびに、変わって
 * いない成功の本文までまとめて運び直さないため。
 */
export function pathFingerprint(rows: FingerprintRow[]): string {
  let hash = 0x811c9dc5;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      // FNV-1a。暗号用途ではなく、変化を取りこぼさないためだけのもの
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const row of rows) {
    feed(row.id);
    feed(":");
    feed(String(row.status ?? ""));
    feed(":");
    feed(isLiveProgress(row) ? "live" : String(row.flushed_at ?? ""));
    feed(":");
    feed(String(row.context_boundary ?? 0));
    feed(":");
    feed((row.sibling_ids ?? []).join(","));
    feed(":");
    for (const a of row.attachments ?? []) {
      feed(a.id);
      feed(a.thumb_at != null ? "+" : "-");
    }
    feed("|");
  }
  return `W/"${rows.length}-${hash.toString(36)}"`;
}

/** パスの中の、生成中の見出しの進捗（無ければ null）。 */
export function liveProgressOf(
  rows: FingerprintRow[],
): { id: string; content: string } | null {
  const row = rows.find(isLiveProgress);
  return row ? { id: row.id, content: row.content ?? "" } : null;
}

/**
 * 304 に添える、生成中の見出しの進捗。
 *
 * 札は見出しの進捗を見ない（上の pathFingerprint）ので、304 のままでは
 * 成功・投げた・待ちの数が画面で止まってしまう。本文を返さない 304 でも
 * 見出しの1行だけは届けるため、ヘッダーに載せる。ヘッダーは ASCII しか
 * 通らないので、JSON を encodeURIComponent して載せる。
 */
export const RUN_PROGRESS_HEADER = "X-Run-Progress";

export function encodeRunProgress(p: { id: string; content: string }): string {
  return encodeURIComponent(JSON.stringify({ id: p.id, content: p.content }));
}

/** 読めなければ null（進捗は次の回で届くので、壊れた値で上書きしない）。 */
export function decodeRunProgress(
  raw: string | null,
): { id: string; content: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as unknown;
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { id?: unknown }).id === "string" &&
      typeof (v as { content?: unknown }).content === "string"
    ) {
      return v as { id: string; content: string };
    }
  } catch {
    // 下へ
  }
  return null;
}

/** 値として同じか（JSON で運べる形だけを比べる。undefined の項は無いのと同じ）。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => sameValue(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameValue(ra[k], rb[k]));
}

/**
 * 取り直したパスで表示を置き換える。**変わっていない行は前の物をそのまま使う。**
 *
 * JSON から作り直した行は、中身が同じでも別の物になる。そのまま渡すと
 * 吹き出しのメモ化（前と同じ物なら描き直さない）が全部外れ、成功が1件
 * 増えるたびに、積み上がった全部の応答を描き直すことになる。
 *
 * 1行も変わっていなければ、配列ごと前の物を返す（React は描き直さない）。
 */
export function reuseUnchangedRows<T extends { id?: string }>(
  prev: T[],
  fresh: T[],
): T[] {
  const byId = new Map<string, T>();
  for (const m of prev) if (m.id) byId.set(m.id, m);
  let same = prev.length === fresh.length;
  const next = fresh.map((m, i) => {
    const old = m.id ? byId.get(m.id) : undefined;
    const kept = old && sameValue(old, m) ? old : m;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : next;
}

/**
 * 表示中の並びと、それを受け取ったときの札。
 *
 * 取り直し（画面へ戻ったとき・引っぱって更新）でも札を送り、変わって
 * いなければ 304 で済ませる。ただし札を送ってよいのは、**画面の並びが
 * その札で受け取ったものから動いていないとき**だけ。送信・枝の移動・
 * 追跡の途中経過で並びが変わったあとに古い札を送ると、サーバーが元の
 * 状態に戻っていた場合に 304 が返り、画面の食い違いが直らない。
 * 並びは不変に扱う（作り直す）ので、物が同じなら中身も同じと言える。
 */
const pathTags = new WeakMap<object, string>();

export function rememberPathTag(list: object, etag: string | null): void {
  if (etag) pathTags.set(list, etag);
}

export function pathTagOf(list: object): string | null {
  return pathTags.get(list) ?? null;
}

/**
 * ポーリングが続けて失敗しているときの待ち。
 *
 * 一過性の失敗（5xx・通信断）で追跡をやめると、生成は続いているのに
 * 表示が生成中のまま誰も追わない状態になる。以前は10回で黙って
 * やめていて、トンネルで回線が数秒切れただけで本文が途中で止まった
 * まま何の表示も無くなっていた（監査 C-2）。
 *
 * かといって同じ間隔で叩き続けるのも電池に効くので、失敗が続くほど
 * 間隔を倍にしていき、上限で頭打ちにする。成功したら元の間隔に戻す。
 */
export const POLL_BACKOFF_MAX_MS = 8_000;
/** これだけの時間、続けて失敗したら諦めて利用者に知らせる。 */
export const POLL_GIVE_UP_MS = 10 * 60_000;

export function pollBackoffMs(failures: number, baseMs: number): number {
  if (failures <= 0) return baseMs;
  return Math.min(baseMs * 2 ** (failures - 1), POLL_BACKOFF_MAX_MS);
}
