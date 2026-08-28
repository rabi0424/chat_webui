/**
 * Cloudflare Access が通した要求かを、Worker 側でも確かめる（多層防御）。
 *
 * アプリの手前には Access が立っていて、本人のメールアドレスだけを通す。
 * ただしそれは Cloudflare 側の設定に依存していて、**設定が外れたことに
 * アプリからは気づけない**——workers.dev のルートを足した、ポリシーの
 * 適用漏れ、といった事故で、会話の全文と生成の入口（＝APIキーを使って
 * 課金が発生する経路）がそのまま公開される。
 *
 * Access を通った要求には署名付きのトークンが付く。その署名と宛先を
 * ここで確かめれば、「Access を通っていない要求」を入口で落とせる。
 *
 * 設定（チームドメインとAUD）が無いときは**何もしない**。手元の開発では
 * Access が前に立たないため、検証すると全部 403 になって開発できなくなる。
 */

export interface AccessConfig {
  /** 例: white-wind-7648.cloudflareaccess.com */
  teamDomain: string;
  /**
   * 受け付ける AUD。
   *
   * Access は「アプリケーション」ごとに別の AUD を発行する。この Worker は
   * 本体URL・プレビューURL・Worker全体の3つのアプリに覆われていて、
   * どれが当たったかで届くトークンの AUD が変わる。1つしか許さないと、
   * プレビューURLから来た正当な要求を落とす。
   */
  audiences: string[];
}

export function readAccessConfig(env: {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const audiences = (env.ACCESS_AUD ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!teamDomain || audiences.length === 0) return null;
  return { teamDomain, audiences };
}

/** 公開鍵の写しを保つ時間。 */
const KEYS_TTL_MS = 60 * 60 * 1000;

interface KeyCache {
  teamDomain: string;
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

/*
 * 鍵はモジュールに持つ。**要求のたびに取りに行ってはならない**——
 * 外部への fetch は1回の呼び出しにつき50件までで、生成中はその枠を
 * 上流への送信が使う。ここで1件ずつ食うと、枠切れで生成が落ちる。
 */
let cache: KeyCache | null = null;

async function loadKeys(
  teamDomain: string,
  force: boolean,
): Promise<Map<string, CryptoKey>> {
  const fresh =
    cache &&
    cache.teamDomain === teamDomain &&
    Date.now() - cache.fetchedAt < KEYS_TTL_MS;
  if (!force && fresh) return cache!.keys;

  try {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`公開鍵の取得に失敗しました (${res.status})`);
    const body = (await res.json()) as { keys?: JsonWebKey[] };
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      const kid = (jwk as { kid?: string }).kid;
      if (!kid || jwk.kty !== "RSA") continue;
      keys.set(
        kid,
        await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    }
    if (keys.size === 0) throw new Error("公開鍵が空でした");
    cache = { teamDomain, keys, fetchedAt: Date.now() };
    return keys;
  } catch (e) {
    // 取り直しに失敗しても、手元に写しがあればそれで検証を続ける。
    // 一時的な通信の失敗で画面が丸ごと 403 になるのは割に合わない
    if (cache && cache.teamDomain === teamDomain) return cache.keys;
    throw e;
  }
}

/** テストから鍵の写しを捨てる（本番からは呼ばない）。 */
export function forgetAccessKeys(): void {
  cache = null;
}

function base64UrlToBytes(segment: string): Uint8Array<ArrayBuffer> {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const binary = atob(padded);
  // ArrayBuffer を明示して作る。長さだけ渡すと型が ArrayBufferLike 由来になり、
  // crypto.subtle.verify が受け取る BufferSource に当てはまらない
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as T;
}

/**
 * トークンの在り処は2つある。
 *
 * ヘッダは Access が付けるもの。Cookie のほうは、ヘッダを落とす経路
 * （リダイレクト直後など）でも残っているので控えとして見る。
 */
function readToken(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header.trim();
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === "CF_Authorization") {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
}

/**
 * その要求を通してよいか。
 *
 * @returns 通してよければ null、断るなら理由（画面には出さずログにだけ残す）
 */
export async function accessDenialReason(
  request: Request,
  config: AccessConfig,
  now: number = Date.now(),
): Promise<string | null> {
  const token = readToken(request);
  if (!token) return "Access のトークンがありません";

  const parts = token.split(".");
  if (parts.length !== 3) return "トークンの形が JWT ではありません";

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = decodeSegment<JwtHeader>(parts[0]);
    payload = decodeSegment<JwtPayload>(parts[1]);
  } catch {
    return "トークンを読めませんでした";
  }

  /*
   * 署名方式は**必ず**確かめる。ここを見ないと、alg を "none" にした
   * 署名なしのトークンや、公開鍵を鍵として使う HMAC のトークンが通る
   * （どちらも誰でも作れる）。検証そのものより先に落とす。
   */
  if (header.alg !== "RS256") {
    return `対応していない署名方式です: ${String(header.alg)}`;
  }
  if (!header.kid) return "鍵の識別子がありません";

  let key: CryptoKey | undefined;
  try {
    key = (await loadKeys(config.teamDomain, false)).get(header.kid);
    if (!key) {
      // 鍵が入れ替わった直後は手元の写しに載っていない。1度だけ取り直す
      key = (await loadKeys(config.teamDomain, true)).get(header.kid);
    }
  } catch (e) {
    return `公開鍵を用意できませんでした: ${(e as Error).message}`;
  }
  if (!key) return "署名した鍵が見つかりません";

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    base64UrlToBytes(parts[2]),
    signed,
  );
  if (!ok) return "署名が一致しません";

  if (payload.iss !== `https://${config.teamDomain}`) {
    return `発行元が違います: ${String(payload.iss)}`;
  }

  /*
   * AUD を見ないと、**同じチームの別のアプリ**向けに発行された
   * トークンで入れてしまう。署名は本物なので、ここだけが宛先の確認になる。
   */
  const aud = Array.isArray(payload.aud)
    ? payload.aud
    : payload.aud
      ? [payload.aud]
      : [];
  if (!aud.some((a) => config.audiences.includes(a))) {
    return "このアプリ向けのトークンではありません";
  }

  const seconds = Math.floor(now / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= seconds) {
    return "トークンの期限が切れています";
  }
  // 時計のずれを少しだけ許す
  if (typeof payload.nbf === "number" && payload.nbf > seconds + 60) {
    return "まだ有効でないトークンです";
  }

  return null;
}
