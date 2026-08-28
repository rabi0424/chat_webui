import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 診断画面（/api/poe/bot-info）が返す生の本文（監査 X-5）。
 *
 * ここは「上流が返したものをそのまま見せる」ための口なので、JSON なら
 * 鍵の名前を見て伏せ字にしていた。しかし返ってくるのが上流のJSONとは
 * 限らない——手前のプロキシがHTMLのエラーページを返すことがあり、
 * そこには**こちらが送った Authorization ヘッダが写っている**ことが
 * ある。JSONとして読めない本文は伏せ字を通らずに出ていた。
 */
const KEY = "poe-secret-key-1234567890";
const OR_KEY = "openrouter-secret-0987654321";

vi.mock("cloudflare:workers", () => ({
  env: { POE_API_KEY: KEY, OPENROUTER_API_KEY: OR_KEY },
  DurableObject: class {},
}));

const { probePoeBot } = await import("../../app/lib/openrouter.server");

/** すべての宛先へ同じ応答を返す。 */
function reply(make: () => Response) {
  vi.stubGlobal("fetch", () => Promise.resolve(make()));
}

const flat = (results: unknown) => JSON.stringify(results);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("APIキーを漏らさない", () => {
  it("JSONとして読めないエラーページのキーも伏せる", async () => {
    reply(
      () =>
        new Response(
          `<html><body>502 Bad Gateway<pre>Authorization: Bearer ${KEY}</pre></body></html>`,
          { status: 502, headers: { "content-type": "text/html" } },
        ),
    );
    const out = flat(await probePoeBot("Claude"));
    expect(out).not.toContain(KEY);
    expect(out).toContain("***");
    // 伏せるだけで、診断に要る手がかりは残す
    expect(out).toContain("502 Bad Gateway");
  });

  it("OpenRouter のキーが混ざっていても伏せる", async () => {
    reply(
      () => new Response(`proxy error: token=${OR_KEY}`, { status: 500 }),
    );
    const out = flat(await probePoeBot("Claude"));
    expect(out).not.toContain(OR_KEY);
  });

  it("JSONの本文でも、値に混ざったキーを伏せる", async () => {
    // 鍵の名前が message なので、名前を見るやり方では見つからない
    reply(
      () =>
        new Response(
          JSON.stringify({ error: { message: `invalid key ${KEY}` } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    const out = flat(await probePoeBot("Claude"));
    expect(out).not.toContain(KEY);
    // JSONとして読めたことは保つ（文字列に落ちていない）
    expect(out).toContain("invalid key ***");
  });

  it("鍵の名前で伏せる従来の経路も残っている", async () => {
    reply(
      () =>
        new Response(JSON.stringify({ api_key: "sk-something-else" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const out = flat(await probePoeBot("Claude"));
    expect(out).not.toContain("sk-something-else");
  });
});
