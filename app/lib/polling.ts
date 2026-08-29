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

/**
 * 表示中のパスの指紋。
 *
 * 「成功するまで生成」の追跡は1秒ごとにパス全体を取り直す。積み上がった
 * 成功の本文まで毎回運ぶので、実行が長引くほど重くなる。中身が変わって
 * いなければ 304 で済ませるための札を作る。
 *
 * 見るのは3つ。**どれか1つでも欠けると、変わったのに変わっていないと
 * 言ってしまう**:
 *   - 行のID: 枝を切り替えるとパスの中身が入れ替わる（件数は同じことがある）
 *   - 最後の書き込み時刻: 生成中の本文が伸びるたびに動く
 *   - 状態: 確定した瞬間を捉える（本文が同じでも streaming → done は伝える）
 */
export function pathFingerprint(
  rows: { id: string; status?: string | null; flushed_at?: number | null }[],
): string {
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
    feed(String(row.status ?? ""));
    feed(String(row.flushed_at ?? ""));
    feed("|");
  }
  return `W/"${rows.length}-${hash.toString(36)}"`;
}
