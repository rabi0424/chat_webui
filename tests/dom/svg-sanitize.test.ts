import { describe, expect, it } from "vitest";
import { looksLikeSvg, sanitizeSvg } from "../../app/lib/svg-sanitize.client";

/**
 * SVGの消毒。本文はモデルの出力（＝間接的に外部由来）なので、
 * ここが抜けると閲覧しただけでスクリプトが走ったり、外部へ通信が飛ぶ。
 *
 * 「落ちていること」を文字列で確かめる。属性が消えるだけでなく、
 * 危険な値そのものが残っていないことまで見る。
 */
const clean = (src: string) => sanitizeSvg(src) ?? "";
const wrap = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;

describe("スクリプトの実行を止める", () => {
  it("<script> を落とす", () => {
    const out = clean(wrap('<script>alert(1)</script><rect width="10" height="10"/>'));
    expect(out).not.toMatch(/script/i);
    expect(out).not.toContain("alert");
    expect(out).toContain("rect");
  });

  it("イベント属性を落とす", () => {
    for (const attr of ["onload", "onclick", "onerror", "onmouseover", "onbegin"]) {
      const out = clean(wrap(`<rect ${attr}="alert(1)" width="10" height="10"/>`));
      expect(out, attr).not.toContain("alert");
      expect(out.toLowerCase(), attr).not.toContain(attr);
    }
  });

  it("javascript: のリンクを落とす", () => {
    const out = clean(wrap('<a href="javascript:alert(1)"><rect width="10" height="10"/></a>'));
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("alert");
  });
});

describe("HTMLの持ち込みを止める", () => {
  it("<foreignObject> を落とす（消毒を素通りする典型的な抜け道）", () => {
    const out = clean(
      wrap('<foreignObject><img src=x onerror="alert(1)"></foreignObject>'),
    );
    expect(out.toLowerCase()).not.toContain("foreignobject");
    expect(out).not.toContain("alert");
  });

  it("iframe・embed・object を落とす", () => {
    for (const tag of ["iframe", "embed", "object"]) {
      const out = clean(wrap(`<${tag} src="https://evil.example/"></${tag}>`));
      expect(out.toLowerCase(), tag).not.toContain(`<${tag}`);
      expect(out, tag).not.toContain("evil.example");
    }
  });
});

describe("外部への通信を止める", () => {
  it("外部URLを指す href を落とす", () => {
    const out = clean(wrap('<image href="https://evil.example/ping.png" width="10" height="10"/>'));
    expect(out).not.toContain("evil.example");
  });

  it("xlink:href の外部参照も落とす", () => {
    const out = clean(wrap('<use xlink:href="https://evil.example/x.svg#a"/>'));
    expect(out).not.toContain("evil.example");
  });

  it("埋め込み済みの画素画像は残す", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    expect(clean(wrap(`<image href="${dataUri}" width="10" height="10"/>`))).toContain(
      "data:image/png",
    );
  });

  it("data: で埋め込まれたSVGは参照させない", () => {
    // 中身がこの消毒を通らないまま参照されるため、画素の画像だけに絞る
    const nested =
      "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=";
    const out = clean(wrap(`<image href="${nested}" width="10" height="10"/>`));
    expect(out).not.toContain("svg+xml");
  });

  it("<use>/<symbol> の中身は落ちる（DOMPurify自身の判断）", () => {
    // 安全側に倒した結果で、アイコンを使い回す書き方の図はその部分が空になる。
    // 意図した挙動であることを、気づけるように書き残しておく
    const out = clean(
      wrap('<defs><rect id="r" width="10" height="10"/></defs><use href="#r"/>'),
    );
    expect(out).not.toContain("<use");
    expect(out).toContain('id="r"');
  });

  it("CSS の @import と url() から外部を取りに行かせない", () => {
    const out = clean(
      wrap('<style>@import url("https://evil.example/x.css"); .a{fill:url(https://evil.example/y.png)}</style><rect class="a" width="10" height="10"/>'),
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("@import");
  });

  it("style 属性からの通信も止める", () => {
    const out = clean(
      wrap('<rect style="background:url(https://evil.example/z.png)" width="10" height="10"/>'),
    );
    expect(out).not.toContain("evil.example");
  });

  it("<style> のクラス定義そのものは残す（消すと図が崩れる）", () => {
    const out = clean(wrap('<style>.a{fill:#f00}</style><rect class="a" width="10" height="10"/>'));
    expect(out).toContain("fill:#f00");
    expect(out).toContain('class="a"');
  });
});

describe("属性の後付け書き換えを止める", () => {
  it("<animate> 系を落とす", () => {
    for (const tag of ["animate", "animateTransform", "animateMotion", "set"]) {
      const out = clean(
        wrap(`<rect width="10" height="10"><${tag} attributeName="href" to="javascript:alert(1)"/></rect>`),
      );
      expect(out.toLowerCase(), tag).not.toContain(`<${tag.toLowerCase()}`);
      expect(out, tag).not.toContain("javascript:");
    }
  });
});

describe("枠に収める", () => {
  it("width/height を外し、viewBox で比率を保つ", () => {
    const out = clean(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="10" height="10"/></svg>',
    );
    expect(out).toContain('viewBox="0 0 320 240"');
    expect(out).not.toMatch(/\swidth="320"/);
    expect(out).not.toMatch(/\sheight="240"/);
    // 作者が想定した大きさを上限に、狭い画面でだけ縮める
    expect(out).toContain("width:min(100%, 320px)");
  });

  it("寸法も viewBox も無ければ、枠なりに広げる", () => {
    const out = clean(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
    );
    expect(out).toContain("max-width:100%");
  });

  it("viewBox があれば、その幅を上限にする", () => {
    // 320px 前提で置かれた文字や線を引き伸ばして不格好にしないため
    const out = clean(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"><rect width="10" height="10"/></svg>',
    );
    expect(out).toContain("width:min(100%, 320px)");
  });
});

describe("SVGとして読めないもの", () => {
  it("null を返す", () => {
    expect(sanitizeSvg("")).toBeNull();
    expect(sanitizeSvg("ただの文章")).toBeNull();
    expect(sanitizeSvg("<div>html</div>")).toBeNull();
    // <svg> が丸ごと落ちる入力
    expect(sanitizeSvg("<script>alert(1)</script>")).toBeNull();
  });
});

describe("looksLikeSvg", () => {
  it("SVGだけを図として扱う", () => {
    expect(looksLikeSvg('<svg xmlns="..."></svg>')).toBe(true);
    expect(looksLikeSvg('  \n <svg viewBox="0 0 1 1"/>')).toBe(true);
    expect(looksLikeSvg('<?xml version="1.0"?><svg></svg>')).toBe(true);
    expect(looksLikeSvg("<!-- 図 --><svg></svg>")).toBe(true);
    expect(looksLikeSvg('<!DOCTYPE svg PUBLIC "..."><svg></svg>')).toBe(true);
  });

  it("SVG以外のXMLは図にしない（```xml は設定ファイルにも使われる）", () => {
    expect(looksLikeSvg("<config><a/></config>")).toBe(false);
    expect(looksLikeSvg('<?xml version="1.0"?><config/>')).toBe(false);
    expect(looksLikeSvg("")).toBe(false);
    // 閉じていない前置きで無限ループしない
    expect(looksLikeSvg("<?xml")).toBe(false);
    expect(looksLikeSvg("<!-- 終わらないコメント")).toBe(false);
    expect(looksLikeSvg("<!doctype")).toBe(false);
  });

  it("svgで始まる別のタグを取り違えない", () => {
    expect(looksLikeSvg("<svgx></svgx>")).toBe(false);
  });
});
