/**
 * 入力欄に貼られたリンクを、取りに行ってよいかどうか判断する。
 *
 * サーバー（実際に取りに行く側）とクライアント（貼られた文字が
 * リンク1本かを見る側）の両方が見るので、`.server` を付けずにここへ置く。
 * 判定を片側だけに置くと、もう片方が文字列を書き写すことになる。
 */

/**
 * 貼り付けられた文字列が「リンク1本だけ」なら、そのURLを返す。
 *
 * 前後の空白は落とす（アプリによっては改行が付いてくる）が、**間に
 * 空白があるものは採らない**——「この記事どう思う? https://…」まで
 * 取り込みにすると、書いた文が消えて何が起きたのか分からなくなる。
 * 文章に混ざったリンクは、そのままの文字として送る。
 *
 * スキームの無い `example.com/a` も採らない。日本語の文中には
 * `。` や `、` で終わる語が普通に出るので、ホスト名らしきものを
 * 拾いにいくと関係の無い貼り付けが取り込みに化ける。
 */
export function pastedUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url.toString();
}

/** 「内側」を指すホスト名の末尾。 */
const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];

/**
 * 到達できてしまうと困るIPv4か。
 *
 * URL の解析器が `http://2130706433/` や `http://127.1/` を
 * `127.0.0.1` へ正規化してくれるので、ここでは点付きの形だけを見れば足りる
 * （10進・8進・省略形をこちらで展開する必要は無い）。
 */
function isPrivateIpv4(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 169.254.169.254 は各社のクラウドで「その機械の設定」を返す口
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** 同じくIPv6（URL の中では `[...]` で括られている）。 */
function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const inner = hostname.slice(1, -1).toLowerCase();
  if (inner === "::1" || inner === "::") return true;
  // IPv4 を埋め込んだ形（`::ffff:7f00:1`）。埋め込みで内側を指せる
  if (inner.startsWith("::ffff:")) return true;
  const head = Number.parseInt(inner.split(":")[0] || "0", 16);
  if (!Number.isFinite(head)) return false;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 ユニークローカル
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 リンクローカル
  return false;
}

/**
 * そのURLを取りに行ってよいか。断るなら理由（画面にそのまま出す）。
 *
 * @param selfHost このアプリ自身のホスト（`request.url` から渡す）。
 *   自分を取りに行かせると、Access のログイン画面を本文として
 *   取り込むか、自分で自分を呼び続けることになる。
 */
export function blockedUrlReason(
  url: URL,
  selfHost?: string | null,
): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "http と https のリンクだけ取り込めます";
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    PRIVATE_SUFFIXES.some((s) => host.endsWith(s)) ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  ) {
    return "このリンクは取り込めません（内側のアドレス）";
  }
  if (selfHost && url.host.toLowerCase() === selfHost.toLowerCase()) {
    return "このリンクは取り込めません（このアプリ自身）";
  }
  return null;
}

/**
 * 札とチップに出すホスト名。
 *
 * `www.` は落とす（幅の狭い画面で効く）が、国際化ドメインは punycode の
 * まま出す——見た目を戻すと、よく似た別ドメインを見分けられなくなる
 * （本文のリンクで行き先のドメインを添えているのと同じ理由。§3.3）。
 */
export function hostLabel(url: string): string {
  try {
    const host = new URL(url).host;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return url;
  }
}
