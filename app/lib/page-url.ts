/**
 * 入力欄に貼られたリンクを、取りに行ってよいかどうか判断する。
 *
 * サーバー（実際に取りに行く側）とクライアント（貼られた文字が
 * リンク1本かを見る側）の両方が見るので、`.server` を付けずにここへ置く。
 * 判定を片側だけに置くと、もう片方が文字列を書き写すことになる。
 */

/**
 * 1通の発言で取り込むページの上限。
 *
 * リンクの並んだ文（メールの引用・検索結果の貼り付け）をそのまま
 * 貼ると、際限なく取りに行くことになる——1本で最大2MBを読み、
 * 本文も1本あたり数万字になるので、10本も取り込めばモデルの
 * コンテキストに入らない。超えたぶんは文字のまま残す。
 */
export const MAX_PAGES_PER_MESSAGE = 5;

/**
 * 貼り付けられた文字列が「リンク1本だけ」なら、そのURLを返す。
 *
 * 前後の空白は落とす（アプリによっては改行が付いてくる）。文章に
 * 混ざったリンクは findUrls が拾うので、こちらは**畳むかどうかの
 * 判断**に使う——リンク1本だけの貼り付けは、長さに関わらず取り込む。
 *
 * スキームの無い `example.com/a` は採らない。日本語の文中には
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

/** 文の中で見つけたリンク1本（置き換えるために位置も返す）。 */
export interface FoundUrl {
  /** 元の文での位置（この範囲を札に置き換える）。 */
  start: number;
  end: number;
  /** 正規化したURL。 */
  url: string;
}

/**
 * リンクの切れ目。
 *
 * **空白では切れない。** 日本語には語の区切りが無いので、
 * `詳しくはhttps://example.com/aを見て` のように地の文がそのまま続く。
 * そこで、かな・漢字・全角の記号はリンクの外側として扱う。
 *
 * 引き換えに、**日本語を含むURL**（`…/wiki/日本語` のように percent
 * 符号化されていない形）は途中で切れる。切れたものをそのまま取りに
 * 行くと別のページが開く——404 なら気づけるが、親の記事が開くと
 * **違うページを読んだまま答えが返る**。切った跡が区切り文字
 * （`/` `?` `=` など）で終わっているときは「続きが落ちた」とみなし、
 * そのリンクは取り込まない（文字のまま残す。リンクだけを貼れば
 * 切れ目を探す必要が無いので、そちらは今までどおり取り込める）。
 */
const CJK = "\\u3000-\\u303f\\u3040-\\u30ff\\u31f0-\\u31ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef\\uac00-\\ud7af";
const URL_RE = new RegExp(`https?://[^\\s<>"\`\\\\^{}|${CJK}]+`, "g");

/** 続きが落ちた跡（この文字で終わるリンクは、途中で切れている）。 */
const CUT_TAIL = /[/?=&_%-]$/;

/** かな・漢字・全角の記号。 */
const CJK_CHAR = new RegExp(`[${CJK}]`);

/**
 * 文末の記号はリンクの一部ではない。
 *
 * `(https://example.com/a)。` の `)` と `。`、`https://example.com/a,`
 * の `,` は地の文の側。ただし**対応の取れている括弧は落とさない**
 * ——`…/wiki/Foo_(bar)` の `)` を落とすと、別の場所を指すリンクに
 * なる（404 になるだけなら気づけるが、親記事が開くこともある）。
 */
function trimTrailing(raw: string): string {
  const count = (s: string, c: string) => s.split(c).length - 1;
  let s = raw;
  for (;;) {
    const last = s.slice(-1);
    if (last === "") break;
    if (last === ")" || last === "]" || last === "}") {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      if (count(s, open) >= count(s, last)) break;
      s = s.slice(0, -1);
      continue;
    }
    // 末尾の `#` は行き先を変えない（断片はサーバーへ送られない）
    if (".,;:!?'\"#".includes(last)) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

/**
 * 文の中の http(s) のリンクを、出てくる順に拾う。
 *
 * 拾うのはスキームの付いたものだけ。`example.com` のような書き方まで
 * 拾いにいくと、`ですます。とか` のような地の文がリンクに化ける。
 */
export function findUrls(text: string): FoundUrl[] {
  const out: FoundUrl[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = trimTrailing(m[0]);
    if (raw === "") continue;
    const start = m.index ?? 0;
    /*
     * かな・漢字でリンクが終わっているように見え、しかも切った跡が
     * 区切り文字なら、URL の続き（日本語のパス）を地の文と一緒に
     * 落としている。取りに行くと別のページが開くので、取り込まない。
     */
    if (CJK_CHAR.test(text[start + m[0].length] ?? "") && CUT_TAIL.test(raw)) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (!url.hostname) continue;
    out.push({ start, end: start + raw.length, url: url.toString() });
  }
  return out;
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
