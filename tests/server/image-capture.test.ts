import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 生成画像の取り込み（監査 X-4・X-7）。
 *
 * 取りに行く宛先を決めるのは**モデルの出力**なので、入口で仕組みと
 * 宛先を確かめている。ところが `fetch` は既定でリダイレクトを追う——
 * 外向きのURLを返しておいて `302` で `127.0.0.1` へ飛ばせば、検査は
 * 素通りしたまま私設アドレスを取りに行っていた（X-4）。
 *
 * 中身の検査も、上流の申告（Content-Type）を信じているだけだった。
 * 申告は上流しだいなので、画像でないものが R2 に入り、そのまま
 * 配信される経路が開いていた（X-7）。
 */
const { captureImagePayload } = await import("../../app/lib/generation.server");

/** 本物のPNG（先頭のマジックナンバーだけ本物にしてある）。 */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
/** 本物のJPEG。 */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
/** 画像のふりをした別のもの。 */
const HTML = new TextEncoder().encode("<html><script>alert(1)</script>");

const image = (bytes: Uint8Array, type = "image/png") =>
  new Response(bytes, { status: 200, headers: { "content-type": type } });

const redirect = (to: string) =>
  new Response(null, { status: 302, headers: { location: to } });

/** 呼ばれたURLを記録しつつ、指定の応答を返す fetch。 */
function install(routes: Record<string, () => Response>) {
  const calls: { url: string; redirect?: string }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, redirect: init?.redirect });
    const make = routes[url];
    if (!make) throw new Error(`用意していない宛先へ出た: ${url}`);
    return Promise.resolve(make());
  });
  return calls;
}

/** 外部リクエストの枠。ここでは数えるだけ。 */
function budget() {
  let spent = 0;
  return {
    spend: () => {
      spent++;
    },
    spent: () => spent,
    spendTouch: () => {},
    touched: () => 0,
    available: () => true,
    canLaunch: () => true,
  };
}

const capture = (url: string, b = budget()) => captureImagePayload(url, b);

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("リダイレクト（X-4）", () => {
  it("素直な200はそのまま取り込む", async () => {
    const calls = install({ "https://cdn.example/a.png": () => image(PNG) });
    const got = await capture("https://cdn.example/a.png");
    expect(got?.mimeType).toBe("image/png");
    // 追うのは自分なので、fetch には追わせない
    expect(calls).toEqual([
      { url: "https://cdn.example/a.png", redirect: "manual" },
    ]);
  });

  it("私設アドレスへ飛ばす 302 は追わない", async () => {
    for (const inner of [
      "http://127.0.0.1/x.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.0.5/x.png",
      "http://cache.internal/x.png",
    ]) {
      const calls = install({
        "https://cdn.example/a.png": () => redirect(inner),
        // 追ってしまったら本物のPNGが返る＝取り込みが成功してしまう。
        // 「用意していない宛先で落ちたから null」では検査にならないので、
        // 飛び先はちゃんと応えるようにしておく
        [inner]: () => image(PNG),
      });
      await expect(capture("https://cdn.example/a.png")).resolves.toBeNull();
      expect(calls.map((c) => c.url), inner).toEqual([
        "https://cdn.example/a.png",
      ]);
    }
  });

  it("外部への 302 は追う（CDNは1回ほど噛ませてくる）", async () => {
    const calls = install({
      "https://cdn.example/a.png": () => redirect("https://img.example/b.png"),
      "https://img.example/b.png": () => image(PNG),
    });
    const b = budget();
    expect((await capture("https://cdn.example/a.png", b))?.mimeType).toBe(
      "image/png",
    );
    expect(calls).toHaveLength(2);
    // 1ホップも外部リクエスト1件。枠の数えから漏らさない
    expect(b.spent()).toBe(2);
  });

  it("相対の Location も元のURLから解く", async () => {
    install({
      "https://cdn.example/dir/a.png": () => redirect("../b.png"),
      "https://cdn.example/b.png": () => image(PNG),
    });
    expect(await capture("https://cdn.example/dir/a.png")).not.toBeNull();
  });

  it("堂々巡りには付き合わない", async () => {
    const calls = install({
      "https://cdn.example/a.png": () => redirect("https://cdn.example/a.png"),
    });
    await expect(capture("https://cdn.example/a.png")).resolves.toBeNull();
    // 上限（3回）まで辿ってやめる
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.length).toBeGreaterThan(1);
  });
});

describe("中身の検査（X-7）", () => {
  it("画像でないものは、画像と申告されていても捨てる", async () => {
    install({ "https://cdn.example/a.png": () => image(HTML) });
    await expect(capture("https://cdn.example/a.png")).resolves.toBeNull();
  });

  it("申告と中身が食い違うときは中身を採る", async () => {
    install({ "https://cdn.example/a.png": () => image(JPEG) });
    expect((await capture("https://cdn.example/a.png"))?.mimeType).toBe(
      "image/jpeg",
    );
  });

  it("data: URL の中身も同じように確かめる", async () => {
    const base64 = (bytes: Uint8Array) =>
      Buffer.from(bytes).toString("base64");
    await expect(
      capture(`data:image/png;base64,${base64(HTML)}`),
    ).resolves.toBeNull();
    expect(
      (await capture(`data:image/png;base64,${base64(PNG)}`))?.mimeType,
    ).toBe("image/png");
  });
});
