import { describe, expect, it } from "vitest";
import { crossSiteReason, isMutating } from "../app/lib/same-origin";

/**
 * 別のサイトからの書き換えを断る。
 *
 * API は Cookie（Cloudflare Access のセッション）で守られているが、
 * Cookie は「どのサイトから出た要求か」に関わらず付いていく。他所の
 * ページに置いた form や fetch からでも、ログイン済みのブラウザなら
 * 通ってしまう——会話の削除もフォルダの削除も、リンクを踏ませるだけで
 * 起こせる状態だった。
 */
const req = (
  method: string,
  headers: Record<string, string> = {},
  url = "https://chat.example.com/api/conversations/c1",
) => new Request(url, { method, headers });

describe("書き換えかどうか", () => {
  it("GET と HEAD は読み取り", () => {
    expect(isMutating("GET")).toBe(false);
    expect(isMutating("HEAD")).toBe(false);
    expect(isMutating("get")).toBe(false);
  });

  it("POST・PATCH・DELETE・PUT は書き換え", () => {
    for (const m of ["POST", "PATCH", "DELETE", "PUT"]) {
      expect(isMutating(m)).toBe(true);
    }
  });
});

describe("受け付けるもの", () => {
  it("読み取りは、どこから来ても通す", () => {
    expect(
      crossSiteReason(req("GET", { "Sec-Fetch-Site": "cross-site" })),
    ).toBeNull();
  });

  it("同じ生成元からの書き換え", () => {
    expect(
      crossSiteReason(req("POST", { "Sec-Fetch-Site": "same-origin" })),
    ).toBeNull();
  });

  it("アドレス欄やブックマークから（none）", () => {
    expect(crossSiteReason(req("POST", { "Sec-Fetch-Site": "none" }))).toBeNull();
  });

  it("Origin が一致していれば通す（Sec-Fetch-Site が無い環境）", () => {
    expect(
      crossSiteReason(req("DELETE", { Origin: "https://chat.example.com" })),
    ).toBeNull();
  });

  it("どちらも無ければ通す（ブラウザ以外からの呼び出し）", () => {
    // curl や別のアプリ。Cookie も自動では付かないので、狙われる形にならない
    expect(crossSiteReason(req("POST"))).toBeNull();
  });
});

describe("断るもの", () => {
  it("別のサイトからの書き換え", () => {
    expect(
      crossSiteReason(req("POST", { "Sec-Fetch-Site": "cross-site" })),
    ).not.toBeNull();
  });

  it("同じサイトの別サブドメインからでも断る", () => {
    // Cookie は生成元より広く共有されるので、same-site でも安心できない
    expect(
      crossSiteReason(req("DELETE", { "Sec-Fetch-Site": "same-site" })),
    ).not.toBeNull();
  });

  it("Origin が別なら断る", () => {
    expect(
      crossSiteReason(req("POST", { Origin: "https://evil.example" })),
    ).not.toBeNull();
  });

  it("ポートが違えば別の生成元", () => {
    expect(
      crossSiteReason(req("POST", { Origin: "https://chat.example.com:8443" })),
    ).not.toBeNull();
  });

  it("スキームが違えば別の生成元", () => {
    expect(
      crossSiteReason(req("POST", { Origin: "http://chat.example.com" })),
    ).not.toBeNull();
  });

  it("壊れた Origin は断る", () => {
    expect(crossSiteReason(req("POST", { Origin: "not a url" }))).not.toBeNull();
  });

  /** Sec-Fetch-Site はページ側から書き換えられないので、こちらを優先する。 */
  it("Origin を詐称しても Sec-Fetch-Site が優先される", () => {
    expect(
      crossSiteReason(
        req("POST", {
          "Sec-Fetch-Site": "cross-site",
          Origin: "https://chat.example.com",
        }),
      ),
    ).not.toBeNull();
  });
});
