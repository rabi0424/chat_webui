import { describe, expect, it } from "vitest";
import { blockedUrlReason, hostLabel, pastedUrl } from "../app/lib/page-url";

/**
 * 貼られたリンクの見分けと、取りに行ってよいかの判定。
 *
 * ここが緩むと、文章に混ざったリンクまで取り込みに化けて（書いた文が
 * 札に置き換わって消える）、あるいは内側のアドレス——このアプリ自身や
 * クラウドの「その機械の設定」を返す口——を代わりに読みに行かせられる。
 * どちらも画面にはそれらしい結果が出るので、判定そのものをここで見る。
 */
describe("貼られた文字がリンク1本か", () => {
  it("リンクだけならそのURL（前後の空白は落とす）", () => {
    expect(pastedUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(pastedUrl("  https://example.com/a\n")).toBe("https://example.com/a");
  });

  it("文章に混ざったリンクは採らない", () => {
    expect(pastedUrl("これ読んで https://example.com/a")).toBeNull();
    expect(pastedUrl("https://example.com/a も見て")).toBeNull();
    expect(pastedUrl("https://example.com/a\nhttps://example.com/b")).toBeNull();
  });

  it("スキームの無いものと、http 以外は採らない", () => {
    expect(pastedUrl("example.com/a")).toBeNull();
    expect(pastedUrl("www.example.com")).toBeNull();
    expect(pastedUrl("javascript:alert(1)")).toBeNull();
    expect(pastedUrl("ftp://example.com/a")).toBeNull();
    expect(pastedUrl("mailto:a@example.com")).toBeNull();
    expect(pastedUrl("")).toBeNull();
    expect(pastedUrl("ただの文")).toBeNull();
  });

  it("ホストの無い http は採らない", () => {
    expect(pastedUrl("http://")).toBeNull();
  });
});

describe("取りに行ってよい宛先か", () => {
  const blocked = (raw: string, self?: string) =>
    blockedUrlReason(new URL(raw), self);

  it("外のサイトは通る", () => {
    expect(blocked("https://example.com/a")).toBeNull();
    expect(blocked("http://203.0.113.10/a")).toBeNull();
  });

  it("内側を指すホスト名は断る", () => {
    for (const raw of [
      "http://localhost/a",
      "http://localhost:8787/a",
      "http://app.localhost/a",
      "http://printer.local/a",
      "http://metadata.internal/a",
      "http://router.home.arpa/a",
    ]) {
      expect(blocked(raw), raw).toMatch(/内側/);
    }
  });

  it("内側を指すIPアドレスは断る", () => {
    for (const raw of [
      "http://127.0.0.1/a",
      "http://10.1.2.3/a",
      "http://172.16.0.1/a",
      "http://172.31.255.255/a",
      "http://192.168.1.1/a",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/a",
      "http://0.0.0.0/a",
      "http://[::1]/a",
      "http://[fd00::1]/a",
      "http://[fe80::1]/a",
      "http://[::ffff:127.0.0.1]/a",
    ]) {
      expect(blocked(raw), raw).toMatch(/内側/);
    }
  });

  /**
   * 10進やドット省略の書き方でも同じところへ着く。URL の解析器が
   * 正規化してくれるので、こちらで展開する必要は無い——が、
   * 「点で4つに区切られた形しか見ない」実装に戻したときに、ここが
   * 気づく唯一の場所になる。
   */
  it("10進・省略形で書かれた 127.0.0.1 も断る", () => {
    expect(blocked("http://2130706433/a")).toMatch(/内側/);
    expect(blocked("http://127.1/a")).toMatch(/内側/);
  });

  /**
   * 範囲のすぐ外は通す。これが無いと「172 で始まれば断る」「192 で
   * 始まれば断る」という粗い実装でも全部通ってしまい、このまとまりは
   * 何も検査していないことになる。
   */
  it("私用の範囲のすぐ外は通す", () => {
    expect(blocked("http://172.32.0.1/a")).toBeNull();
    expect(blocked("http://172.15.0.1/a")).toBeNull();
    expect(blocked("http://192.169.1.1/a")).toBeNull();
    expect(blocked("http://11.0.0.1/a")).toBeNull();
    expect(blocked("http://[2001:db8::1]/a")).toBeNull();
  });

  it("このアプリ自身は断る（大文字小文字は問わない）", () => {
    expect(blocked("https://chat.example.com/a", "chat.example.com")).toMatch(
      /このアプリ自身/,
    );
    expect(blocked("https://CHAT.example.com/a", "chat.example.com")).toMatch(
      /このアプリ自身/,
    );
    expect(blocked("https://other.example.com/a", "chat.example.com")).toBeNull();
    // ポートまで含めて同じときだけ（開発では別のポートで動く）
    expect(blocked("https://example.com:8788/a", "example.com:8787")).toBeNull();
  });

  it("http と https 以外は断る", () => {
    expect(blocked("ftp://example.com/a")).toMatch(/http/);
    expect(blocked("file:///etc/passwd")).toMatch(/http/);
  });
});

describe("札とチップに出すホスト名", () => {
  it("www. だけ落とし、ポートと国際化ドメインはそのまま", () => {
    expect(hostLabel("https://www.example.com/a")).toBe("example.com");
    expect(hostLabel("https://news.example.com/a")).toBe("news.example.com");
    expect(hostLabel("http://example.com:8080/a")).toBe("example.com:8080");
    // punycode のまま出す（よく似た別ドメインを見分けられなくなるため）
    expect(hostLabel("https://日本語.jp/a")).toBe("xn--wgv71a119e.jp");
  });

  it("URLとして読めないものはそのまま返す", () => {
    expect(hostLabel("これはURLではない")).toBe("これはURLではない");
  });
});
