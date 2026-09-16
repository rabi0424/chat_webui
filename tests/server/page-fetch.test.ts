import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PAGE_BYTES,
  MAX_PAGE_REDIRECTS,
  charsetOf,
  decodeBody,
  fetchPage,
} from "../../app/lib/page-fetch.server";

/**
 * 貼られたリンクを取ってくるところ。
 *
 * ここが崩れたときの出方は「取り込めない」ではなく、**それらしい本文が
 * 入って送られる**——文字化けした本文、途中で切れた本文、あるいは
 * 転送の先で内側のアドレスを読ませられた結果。どれも画面にはエラーが
 * 出ないので、応答の組み立てを直に見る。
 */

/** 上流の振りをする。URLごとの応答を決め、呼ばれた順と渡された指定を残す。 */
function installFetch(
  routes: Record<string, () => Response | Promise<Response>>,
): { seen: string[]; inits: (RequestInit | undefined)[] } {
  const seen: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    inits.push(init);
    const hit = routes[url];
    if (!hit) throw new Error(`知らないURL: ${url}`);
    return await hit();
  }) as typeof fetch;
  return { seen, inits };
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });

const redirect = (to: string) =>
  new Response("", { status: 302, headers: { Location: to } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("取ってくる", () => {
  it("HTML はそのまま返し、型から charset を落とす", async () => {
    const { inits } = installFetch({
      "https://example.com/a": () => html("<h1>見出し</h1>"),
    });
    const result = await fetchPage("https://example.com/a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.body).toBe("<h1>見出し</h1>");
    expect(result.page.contentType).toBe("text/html");
    expect(result.page.url).toBe("https://example.com/a");
    /*
     * 転送を**自分で**追う指定になっているか。
     *
     * ここだけは振る舞いでは押さえられない——差し替えた fetch は
     * ランタイムと違って自動では追わないので、`follow` に戻しても
     * テストの中では同じ動きに見える。本番では「最後の行き先しか
     * 見られない」に変わり、下の『転送の先が内側のアドレスなら』は
     * 検査する機会そのものを失う。指定の側を見張る。
     */
    expect(inits[0]?.redirect).toBe("manual");
  });

  it("転送を追い、行き着いた先のURLを返す", async () => {
    const { seen } = installFetch({
      "https://short.example/x": () => redirect("https://example.com/article"),
      // 相対の行き先も辿れること
      "https://example.com/article": () => redirect("./body"),
      "https://example.com/body": () => html("<p>本文</p>"),
    });
    const result = await fetchPage("https://short.example/x");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.url).toBe("https://example.com/body");
    expect(seen).toHaveLength(3);
  });

  /**
   * ここが**このまとまりで一番効くテスト**。`redirect: "manual"` を
   * `"follow"` に戻すと、転送の先は ランタイム が勝手に読みに行くので、
   * 断る機会そのものが無くなる（最後の行き先しか見られない）。
   * 「2件目を取りに行っていないこと」まで見る。
   */
  it("転送の先が内側のアドレスなら、取りに行かずに断る", async () => {
    const { seen } = installFetch({
      "https://example.com/a": () => redirect("http://169.254.169.254/meta"),
      "http://169.254.169.254/meta": () => html("秘密"),
    });
    const result = await fetchPage("https://example.com/a");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/内側/);
    expect(seen).toEqual(["https://example.com/a"]);
  });

  it("転送が巡回していたら、段数で打ち切る", async () => {
    const { seen } = installFetch({
      "https://example.com/a": () => redirect("https://example.com/b"),
      "https://example.com/b": () => redirect("https://example.com/a"),
    });
    const result = await fetchPage("https://example.com/a");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/転送が多すぎます/);
    expect(seen).toHaveLength(MAX_PAGE_REDIRECTS + 1);
  });

  it("内側のアドレスは、そもそも取りに行かない", async () => {
    const { seen } = installFetch({});
    const result = await fetchPage("http://localhost:8787/api/settings");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/内側/);
    expect(seen).toEqual([]);
  });

  it("このアプリ自身も取りに行かない", async () => {
    const { seen } = installFetch({});
    const result = await fetchPage("https://chat.example.com/chat/1", "chat.example.com");
    expect(result.ok).toBe(false);
    expect(seen).toEqual([]);
  });

  it("文字として読めない型は断る", async () => {
    installFetch({
      "https://example.com/a.png": () =>
        new Response("", { headers: { "Content-Type": "image/png" } }),
    });
    const result = await fetchPage("https://example.com/a.png");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(415);
    expect(result.error).toMatch(/image\/png/);
  });

  it("プレーンテキストと JSON は通す", async () => {
    installFetch({
      "https://example.com/a.txt": () =>
        new Response("ただの文", { headers: { "Content-Type": "text/plain" } }),
      "https://example.com/a.json": () =>
        new Response("{}", { headers: { "Content-Type": "application/json" } }),
    });
    expect((await fetchPage("https://example.com/a.txt")).ok).toBe(true);
    expect((await fetchPage("https://example.com/a.json")).ok).toBe(true);
  });

  it("上限を超える本文は捨てる（読み切ってから測らない）", async () => {
    installFetch({
      "https://example.com/big": () =>
        new Response("a".repeat(MAX_PAGE_BYTES + 1), {
          headers: { "Content-Type": "text/html" },
        }),
    });
    const result = await fetchPage("https://example.com/big");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(413);
  });

  it("上限ちょうどは通す", async () => {
    installFetch({
      "https://example.com/big": () =>
        new Response("a".repeat(MAX_PAGE_BYTES), {
          headers: { "Content-Type": "text/html" },
        }),
    });
    expect((await fetchPage("https://example.com/big")).ok).toBe(true);
  });

  it("読めなかった応答は、状態コードを添えて断る", async () => {
    installFetch({
      "https://example.com/a": () =>
        new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/html" },
        }),
    });
    const result = await fetchPage("https://example.com/a");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/HTTP 404/);
  });

  it("通信そのものが失敗したら、理由を添えて断る", async () => {
    installFetch({
      "https://example.com/a": () => {
        throw new Error("接続できません");
      },
    });
    const result = await fetchPage("https://example.com/a");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.error).toMatch(/接続できません/);
  });
});

/**
 * 文字コード。**日本語のページには今でも Shift_JIS が居る。**
 * utf-8 と決め打ちすると、本文が丸ごと化けたままモデルへ渡り、
 * 画面には何のエラーも出ない。
 */
describe("文字コードの決め方", () => {
  /** 「日本語」の Shift_JIS。 */
  const SJIS = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

  it("ヘッダの charset が最優先", () => {
    expect(charsetOf("text/html; charset=Shift_JIS", new ArrayBuffer(0))).toBe(
      "shift_jis",
    );
    expect(charsetOf('text/html;charset="EUC-JP"', new ArrayBuffer(0))).toBe(
      "euc-jp",
    );
  });

  it("ヘッダに無ければ HTML の頭の宣言を見る", () => {
    const head = new TextEncoder().encode(
      '<!doctype html><meta charset="Shift_JIS"><title>あ</title>',
    );
    expect(charsetOf("text/html", head.buffer as ArrayBuffer)).toBe("shift_jis");
  });

  it("どこにも無ければ utf-8", () => {
    const head = new TextEncoder().encode("<!doctype html><title>あ</title>");
    expect(charsetOf(null, head.buffer as ArrayBuffer)).toBe("utf-8");
  });

  it("宣言が本文の遠くにあるものは追いかけない（頭だけ見る）", () => {
    const head = new TextEncoder().encode(
      `<!doctype html>${"<!-- 埋め草 -->".repeat(400)}<meta charset="Shift_JIS">`,
    );
    expect(charsetOf("text/html", head.buffer as ArrayBuffer)).toBe("utf-8");
  });

  it("決めた文字コードで読む", () => {
    expect(decodeBody(SJIS.buffer as ArrayBuffer, "shift_jis")).toBe("日本語");
    // utf-8 と決め打ちにすると化ける（＝上のテストが効いている）
    expect(decodeBody(SJIS.buffer as ArrayBuffer, "utf-8")).not.toBe("日本語");
  });

  it("知らない名前は utf-8 に落とす（例外で1本を失わない）", () => {
    const utf8 = new TextEncoder().encode("日本語");
    expect(decodeBody(utf8.buffer as ArrayBuffer, "x-unknown-1")).toBe("日本語");
  });

  it("取ってくるところまで通して、Shift_JIS のページが読める", async () => {
    installFetch({
      "https://example.com/sjis": () =>
        new Response(SJIS, {
          headers: { "Content-Type": "text/html; charset=Shift_JIS" },
        }),
    });
    const result = await fetchPage("https://example.com/sjis");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.body).toBe("日本語");
  });
});
