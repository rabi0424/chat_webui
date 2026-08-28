import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessDenialReason,
  forgetAccessKeys,
  readAccessConfig,
  type AccessConfig,
} from "../../app/lib/access-jwt.server";

/**
 * Cloudflare Access のトークン検証。
 *
 * ここが素通しになると、Access の設定が外れたことに誰も気づけないまま
 * 会話の全文と生成の入口が公開される——画面には何も出ない壊れ方なので、
 * 偽造の手口ひとつずつに対して落ちることを見る。
 *
 * 本物の鍵で署名して検証まで通すので、「検証しているつもりで何も見て
 * いない」状態にはならない（署名を1バイト変えれば落ちる）。
 */

const TEAM = "example.cloudflareaccess.com";
const AUD_A = "aud-production";
const AUD_B = "aud-preview";
const CONFIG: AccessConfig = { teamDomain: TEAM, audiences: [AUD_A, AUD_B] };
const NOW = 1_800_000_000_000;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

async function generate() {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

let pair: CryptoKeyPair;
/** 上流が別の鍵に入れ替えた場合を作るための、2本目の鍵。 */
let other: CryptoKeyPair;
let served: { keys: unknown[] };
let fetchCalls = 0;

async function jwkOf(pub: CryptoKey, kid: string) {
  const jwk = await crypto.subtle.exportKey("jwk", pub);
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

interface TokenOptions {
  kid?: string;
  alg?: string;
  key?: CryptoKey;
  payload?: Record<string, unknown>;
  /** 署名だけ壊す。 */
  tamper?: boolean;
}

async function token(opts: TokenOptions = {}): Promise<string> {
  const header = b64urlText(
    JSON.stringify({
      alg: opts.alg ?? "RS256",
      kid: opts.kid ?? "k1",
      typ: "JWT",
    }),
  );
  const payload = b64urlText(
    JSON.stringify({
      iss: `https://${TEAM}`,
      aud: AUD_A,
      exp: Math.floor(NOW / 1000) + 3600,
      email: "someone@example.com",
      ...opts.payload,
    }),
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    opts.key ?? pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const bytes = new Uint8Array(signature);
  if (opts.tamper) bytes[0] ^= 0xff;
  return `${header}.${payload}.${b64url(bytes)}`;
}

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://chat.example.com/", { headers });
}

beforeEach(async () => {
  pair = await generate();
  other = await generate();
  served = { keys: [await jwkOf(pair.publicKey, "k1")] };
  fetchCalls = 0;
  forgetAccessKeys();
  vi.stubGlobal("fetch", async (url: string) => {
    expect(String(url)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    fetchCalls++;
    return new Response(JSON.stringify(served), { status: 200 });
  });
});

const check = (t: string, headerName = "Cf-Access-Jwt-Assertion") =>
  accessDenialReason(requestWith({ [headerName]: t }), CONFIG, NOW);

describe("Access のトークン検証", () => {
  it("正しいトークンは通る", async () => {
    expect(await check(await token())).toBeNull();
  });

  it("Cookie に入っていても通る", async () => {
    const t = await token();
    const req = requestWith({
      Cookie: `foo=bar; CF_Authorization=${t}; baz=1`,
    });
    expect(await accessDenialReason(req, CONFIG, NOW)).toBeNull();
  });

  it("署名を1バイト変えると落ちる", async () => {
    expect(await check(await token({ tamper: true }))).toBe(
      "署名が一致しません",
    );
  });

  it("別の鍵で署名したものは落ちる", async () => {
    expect(await check(await token({ key: other.privateKey }))).toBe(
      "署名が一致しません",
    );
  });

  it("alg を none にした署名なしのトークンは落ちる", async () => {
    // 署名の中身に関係なく、方式の時点で断る
    const header = b64urlText(JSON.stringify({ alg: "none", kid: "k1" }));
    const payload = b64urlText(
      JSON.stringify({
        iss: `https://${TEAM}`,
        aud: AUD_A,
        exp: 9_999_999_999,
      }),
    );
    const reason = await check(`${header}.${payload}.`);
    expect(reason).toContain("対応していない署名方式");
  });

  it("宛先（AUD）が違うトークンは落ちる", async () => {
    // 署名は本物。同じチームの別アプリ向けトークンを想定する
    const reason = await check(
      await token({ payload: { aud: "aud-other-app" } }),
    );
    expect(reason).toBe("このアプリ向けのトークンではありません");
  });

  it("設定に並べたどの AUD でも通る", async () => {
    expect(await check(await token({ payload: { aud: AUD_B } }))).toBeNull();
    // 配列で複数入っていても、1つ一致すれば通る
    expect(
      await check(await token({ payload: { aud: ["aud-other-app", AUD_B] } })),
    ).toBeNull();
  });

  it("発行元が違うトークンは落ちる", async () => {
    const reason = await check(
      await token({ payload: { iss: "https://evil.cloudflareaccess.com" } }),
    );
    expect(reason).toContain("発行元が違います");
  });

  it("期限切れのトークンは落ちる", async () => {
    const reason = await check(
      await token({ payload: { exp: Math.floor(NOW / 1000) - 1 } }),
    );
    expect(reason).toBe("トークンの期限が切れています");
  });

  it("期限が入っていないトークンは落ちる", async () => {
    const reason = await check(await token({ payload: { exp: undefined } }));
    expect(reason).toBe("トークンの期限が切れています");
  });

  it("トークンが無ければ落ちる", async () => {
    const reason = await accessDenialReason(requestWith({}), CONFIG, NOW);
    expect(reason).toBe("Access のトークンがありません");
  });

  it("JWT の形をしていないものは落ちる", async () => {
    expect(await check("not-a-jwt")).toBe("トークンの形が JWT ではありません");
  });

  it("鍵を取りに行けず、写しも無ければ落ちる（素通しにしない）", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const reason = await check(await token());
    expect(reason).toContain("公開鍵を用意できませんでした");
  });

  it("鍵が入れ替わったら取り直す", async () => {
    // まず古い鍵で1回通し、写しを作る
    expect(await check(await token())).toBeNull();
    // 上流が k2 へ入れ替えた。手元の写しには無いので取り直しになる
    served = { keys: [await jwkOf(other.publicKey, "k2")] };
    const fresh = await token({ kid: "k2", key: other.privateKey });
    expect(await check(fresh)).toBeNull();
  });

  it("鍵は要求のたびに取りに行かない（外部fetchの枠を食わない）", async () => {
    await check(await token());
    await check(await token());
    await check(await token());
    expect(fetchCalls).toBe(1);
  });
});

describe("設定の読み取り", () => {
  it("両方そろって初めて有効になる", () => {
    expect(readAccessConfig({})).toBeNull();
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
    expect(readAccessConfig({ ACCESS_AUD: AUD_A })).toBeNull();
    expect(
      readAccessConfig({ ACCESS_TEAM_DOMAIN: "  ", ACCESS_AUD: AUD_A }),
    ).toBeNull();
  });

  it("AUD はカンマ区切りで複数受け取る", () => {
    const c = readAccessConfig({
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: ` ${AUD_A} , ${AUD_B} ,, `,
    });
    expect(c).toEqual({ teamDomain: TEAM, audiences: [AUD_A, AUD_B] });
  });
});
