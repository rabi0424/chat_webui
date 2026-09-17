import { describe, expect, it } from "vitest";
import { TRUNCATED_MARK, extractPage } from "../../app/lib/page-extract.client";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";

/** 既定の上限（設定の `pageMaxChars`）。 */
const MAX = DEFAULT_APP_SETTINGS.pageMaxChars;

/**
 * 取ってきた HTML から、モデルに渡す本文を作るところ。
 *
 * 壊れ方は「本文が空」ではなく **「それらしいが中身の違う本文」**
 * ——飾りだけを拾う、表の行と列がずれる、リンクが相対のまま渡って
 * 参照できない。どれも送った後に気づけないので、出来上がりの文字を
 * 直に見る。
 */
const page = (body: string, contentType = "text/html", maxChars = MAX) =>
  extractPage(
    { url: "https://example.com/dir/page.html", contentType, body },
    maxChars,
  );

describe("本文の取り出し", () => {
  it("スクリプト・スタイル・飾りは落とす", () => {
    const { text } = page(`
      <body>
        <nav>ホーム メニュー</nav>
        <script>const secret = "スクリプトの中身";</script>
        <style>.a { color: red }</style>
        <div aria-hidden="true">飾りの文字</div>
        <p>これが本文です。</p>
        <aside>関連記事</aside>
      </body>`);
    expect(text).toContain("これが本文です。");
    expect(text).not.toContain("スクリプトの中身");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("飾りの文字");
    expect(text).not.toContain("メニュー");
    expect(text).not.toContain("関連記事");
  });

  it("見出しはマークダウンの見出しになる", () => {
    const { text } = page("<h1>大見出し</h1><p>本文</p><h2>小見出し</h2>");
    expect(text).toContain("# 大見出し");
    expect(text).toContain("## 小見出し");
  });

  it("段落は空行で分かれる（地続きにならない）", () => {
    const { text } = page("<p>ひとつめ</p><p>ふたつめ</p>");
    expect(text).toBe("ひとつめ\n\nふたつめ");
  });

  it("箇条書きは印つき、順序付きは番号つき", () => {
    const { text } = page(
      "<ul><li>あ</li><li>い</li></ul><ol><li>いち</li><li>に</li></ol>",
    );
    expect(text).toContain("- あ");
    expect(text).toContain("- い");
    expect(text).toContain("1. いち");
    expect(text).toContain("2. に");
  });

  it("表は行と列の対応が残る（枡の区切りは逃がす）", () => {
    const { text } = page(
      "<table><tr><th>名前</th><th>値</th></tr>" +
        "<tr><td>あ</td><td>1|2</td></tr></table>",
    );
    expect(text).toContain("| 名前 | 値 |");
    expect(text).toContain("| --- | --- |");
    expect(text).toContain("| あ | 1\\|2 |");
  });

  it("リンクは絶対URLになる（相対のままでは参照できない）", () => {
    const { text } = page('<p><a href="../other.html">別の記事</a></p>');
    expect(text).toContain("[別の記事](https://example.com/other.html)");
  });

  it("行き先の無いリンクは文字として残す", () => {
    const { text } = page(
      '<p><a href="#top">先頭へ</a><a href="javascript:void(0)">押す</a></p>',
    );
    expect(text).toContain("先頭へ");
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("](#top)");
  });

  /**
   * 画像は説明だけを残し、**画像記法にはしない**。本文は自分の発言と
   * して画面にも出るが、外部の画像は CSP で止めてある（`lib/csp.ts`）
   * ので、記法で書くと必ず壊れた画像として並ぶ。
   */
  it("画像は説明だけを残す（画像記法にはしない）", () => {
    const { text } = page(
      '<p><img src="/a.png" alt="図1 内訳"><img src="/spacer.gif" alt=""></p>',
    );
    expect(text).toContain("（画像: 図1 内訳）");
    expect(text).not.toContain("![");
    expect(text).not.toContain("a.png");
    expect(text).not.toContain("spacer.gif");
  });

  it("コードは囲いに入れ、字下げを保つ", () => {
    const { text } = page("<pre><code>function a() {\n  return 1;\n}</code></pre>");
    expect(text).toContain("```\nfunction a() {\n  return 1;\n}\n```");
  });

  it("空白と改行は畳む（HTML の字下げが本文に出ない）", () => {
    const { text } = page("<p>\n    ひとつの     文\n  </p>");
    expect(text).toBe("ひとつの 文");
  });
});

describe("本文の在り処", () => {
  const LONG = "本文です。".repeat(60); // MAIN_MIN_CHARS を超える長さ

  it("<main> があればそこだけを読む", () => {
    const { text } = page(
      `<body><div>外側の飾り</div><main><p>${LONG}</p></main></body>`,
    );
    expect(text).toContain("本文です。");
    expect(text).not.toContain("外側の飾り");
  });

  /**
   * 飾りに `<main>` を付けているページがある。`<main>` を無条件で
   * 信じると、本文がまるごと落ちたものを「取り込めた」として渡す。
   */
  it("<main> が薄ければ、body 全体から読む", () => {
    const { text } = page(
      `<body><main><p>広告</p></main><div><p>${LONG}</p></div></body>`,
    );
    expect(text).toContain("本文です。");
  });

  it("<main> が複数あれば、中身の多いほうを読む", () => {
    const { text } = page(
      `<body><article><p>短い添え物</p></article><article><p>${LONG}</p></article></body>`,
    );
    expect(text).toContain("本文です。");
    expect(text).not.toContain("短い添え物");
  });
});

describe("見出し", () => {
  it("og:title → title → h1 の順に拾う", () => {
    expect(
      page('<head><meta property="og:title" content="OGの題"><title>題</title></head><h1>見出し</h1>')
        .title,
    ).toBe("OGの題");
    expect(page("<head><title>題</title></head><h1>見出し</h1>").title).toBe("題");
    expect(page("<body><h1>見出し</h1></body>").title).toBe("見出し");
    expect(page("<body><p>本文</p></body>").title).toBe("");
  });
});

describe("長さの上限", () => {
  it("超えたら切って、切ったことを本文に書く", () => {
    const { text, truncated } = page(`<p>${"あ".repeat(MAX + 10)}</p>`);
    expect(truncated).toBe(true);
    expect(text).toContain(TRUNCATED_MARK);
    expect(text.length).toBeLessThanOrEqual(MAX + TRUNCATED_MARK.length + 2);
  });

  /**
   * 上限は設定から渡る。ここを固定値で持っていると、設定を変えても
   * 切られる長さが変わらない（画面には何も出ない）。
   */
  it("上限は渡された値に従う", () => {
    const { text, truncated } = page(`<p>${"あ".repeat(500)}</p>`, "text/html", 100);
    expect(truncated).toBe(true);
    expect(text.startsWith("あ".repeat(100))).toBe(true);
    expect(text.length).toBeLessThan(200);
  });

  it("上限までなら切らない", () => {
    const { text, truncated } = page(`<p>${"あ".repeat(100)}</p>`);
    expect(truncated).toBe(false);
    expect(text).not.toContain(TRUNCATED_MARK);
  });
});

describe("HTML でないもの", () => {
  it("プレーンテキストはそのまま通す", () => {
    const { text, title } = page("行1\n行2\n", "text/plain");
    expect(text).toBe("行1\n行2");
    expect(title).toBe("");
  });

  it("JSON もそのまま通す（タグとして読まない）", () => {
    const { text } = page('{"a": "<b>"}', "application/json");
    expect(text).toBe('{"a": "<b>"}');
  });
});
