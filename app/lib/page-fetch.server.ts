/**
 * 貼られたリンクの中身を取ってくる。
 *
 * ここでやるのは「取ってきて、文字にするところまで」で、本文の
 * 取り出し（HTML → 読める文章）はブラウザ側（`page-extract.client.ts`）に
 * 置いてある。Workers の無料プランは1回の呼び出しで CPU 10ms しか
 * 使えず、数百KBのHTMLを解析すると足りない——同じ理由で画像の縮小も
 * ブラウザにやらせている（`lib/constants.ts` の縮小版の項）。
 *
 * 秘密は要らない（鍵を使わない外部通信）が、クライアントから直に
 * 取りに行くことはできない（CORS で読めない）ので、ここを通す。
 */
import { blockedUrlReason } from "./page-url";
import { readBounded } from "./read-bounded";
import { DEFAULT_APP_SETTINGS } from "./settings";

/**
 * 取得の上限（設定から渡す）。
 *
 * 既定は `DEFAULT_APP_SETTINGS` の `pageMaxMb` / `pageTimeoutSec`。
 * **値を書き写さない**——設定を変えても、書き写した側が古いままだと
 * 「設定したのに効かない」という、画面に何も出ない壊れ方をする。
 */
export interface PageLimits {
  /** 受け取る本文の上限（バイト）。 */
  maxBytes: number;
  /** 1本にかける時間の上限（ミリ秒）。 */
  timeoutMs: number;
}

export function pageLimitsOf(settings: {
  pageMaxMb: number;
  pageTimeoutSec: number;
}): PageLimits {
  return {
    maxBytes: settings.pageMaxMb * 1024 * 1024,
    timeoutMs: settings.pageTimeoutSec * 1000,
  };
}

/** 設定を渡されなかったときの上限（既定の設定と同じ値）。 */
export const DEFAULT_PAGE_LIMITS = pageLimitsOf(DEFAULT_APP_SETTINGS);

/**
 * 追いかけるリダイレクトの段数。
 *
 * `redirect: "follow"` に任せず自分で追うのは、**途中の行き先を
 * 1段ずつ検査する**ため。任せると、最後の行き先しか見られない
 * ——短縮URLが内側のアドレスへ飛ばしていても、気づいたときには
 * 既に取りに行った後になる。
 */
export const MAX_PAGE_REDIRECTS = 5;

/** ブラウザと同じ顔で名乗る（名乗らないと断るサイトがある）。 */
const USER_AGENT =
  "Mozilla/5.0 (compatible; chat-webui/1.0; +https://github.com/rabi0424/chat_webui)";

/** 文字として読み取れる形式か。 */
const TEXTUAL_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "text/xml",
  "application/xml",
  "application/json",
  "text/csv",
];

export interface FetchedPage {
  /** リダイレクトを追い終わった先のURL。 */
  url: string;
  /** `text/html` など（`charset` は落とす）。 */
  contentType: string;
  /** 本文（HTML なら HTML のまま）。 */
  body: string;
}

export type PageFetchResult =
  | { ok: true; page: FetchedPage }
  | { ok: false; error: string; status: number };

/** `Content-Type` から型だけを取り出す。 */
export function mediaTypeOf(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

export function isTextualType(mediaType: string): boolean {
  return TEXTUAL_TYPES.includes(mediaType) || mediaType.startsWith("text/");
}

/**
 * 文字コードを決める。
 *
 * ヘッダの `charset` が最優先。無ければ HTML の頭にある宣言を見る
 * ——**日本語のページには今でも Shift_JIS や EUC-JP が居る**。
 * utf-8 と決め打ちすると、本文が丸ごと文字化けしたままモデルへ渡り、
 * 画面にはエラーが出ない。
 */
export function charsetOf(
  contentType: string | null,
  head: ArrayBuffer,
): string {
  const fromHeader = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType ?? "");
  if (fromHeader) return fromHeader[1].toLowerCase();
  // 宣言そのものは ASCII なので、どの文字コードでも utf-8 として読める
  const text = new TextDecoder("utf-8").decode(head.slice(0, 2048));
  const meta =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(text) ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(text);
  return meta ? meta[1].toLowerCase() : "utf-8";
}

/**
 * 決めた文字コードで読む。知らない名前なら utf-8 に落とす
 * （読めない名前で落ちるより、化けてでも本文が出るほうがまし）。
 */
export function decodeBody(body: ArrayBuffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/**
 * リンクの中身を取ってくる。
 *
 * 失敗は例外ではなく理由で返す。ルートはそれをそのまま画面へ出し、
 * 画面は「リンクだけにして送る」に落とせる——取り込めなかったことを
 * 黙って捨てると、利用者は本文が入ったつもりで送ることになる。
 */
export async function fetchPage(
  raw: string,
  selfHost?: string | null,
  limits: PageLimits = DEFAULT_PAGE_LIMITS,
): Promise<PageFetchResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "URLとして読めません", status: 400 };
  }

  const deadline = AbortSignal.timeout(limits.timeoutMs);
  let res: Response;
  let hops = 0;
  for (;;) {
    const blocked = blockedUrlReason(url, selfHost);
    if (blocked) return { ok: false, error: blocked, status: 400 };
    try {
      res = await fetch(url.toString(), {
        // 追いかけるのは自分。途中の行き先を1段ずつ検査するため
        redirect: "manual",
        signal: deadline,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "Accept-Language": "ja,en;q=0.8",
        },
      });
    } catch (e) {
      const reason = deadline.aborted
        ? `${Math.round(limits.timeoutMs / 1000)}秒で応答がありませんでした`
        : ((e as Error).message ?? String(e));
      return {
        ok: false,
        error: `ページを取得できませんでした（${reason}）`,
        status: 502,
      };
    }
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get("Location");
    if (!location) break; // 行き先が無い 3xx はそのまま扱う
    if (++hops > MAX_PAGE_REDIRECTS) {
      return {
        ok: false,
        error: "転送が多すぎます（リンクが巡回しています）",
        status: 502,
      };
    }
    try {
      url = new URL(location, url);
    } catch {
      return { ok: false, error: "転送先のURLを読めません", status: 502 };
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      error: `ページが読めませんでした（HTTP ${res.status}）`,
      status: 502,
    };
  }

  const mediaType = mediaTypeOf(res.headers.get("Content-Type"));
  if (!isTextualType(mediaType)) {
    return {
      ok: false,
      error: `このリンクは取り込めません（${mediaType || "形式不明"}）`,
      status: 415,
    };
  }

  // 本文の無い応答（204 など）。ここで分けておかないと、下の
  // readBounded が null を返すのを「大きすぎる」と読み違える
  if (!res.body) {
    return { ok: true, page: { url: url.toString(), contentType: mediaType, body: "" } };
  }

  const body = await readBounded(res, limits.maxBytes);
  if (!body) {
    return {
      ok: false,
      error: `ページが大きすぎます（上限 ${Math.round(limits.maxBytes / 1024 / 1024)}MB）`,
      status: 413,
    };
  }

  return {
    ok: true,
    page: {
      url: url.toString(),
      contentType: mediaType,
      body: decodeBody(body, charsetOf(res.headers.get("Content-Type"), body)),
    },
  };
}
