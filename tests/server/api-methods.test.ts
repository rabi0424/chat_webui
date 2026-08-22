import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 更新の動詞と、405 の名乗り（監査 C-1）。
 *
 * 同じ「一部を書き換える」操作が、ルートによって PUT だったり、PATCH と
 * POST の両方を受けたりしていた。呼ぶ側はルートごとの正解を覚えることに
 * なり、間違えても 405 が返るだけで理由は分からない。
 *
 * さらに 405 は Allow ヘッダを返していなかった。**受け口の一覧と 405 の
 * 応答が別々に書かれていた**ので、受け口を増やしても名乗りは古いまま、
 * という状態を作れる。どちらも画面には何も出ない。
 *
 * ここでは本物のルートを呼ぶ。405 は入口で返るのでバインディングには
 * 触らない——触ってしまえば、差し替えた env の Proxy がその場で投げる。
 */
const VOCABULARY = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

interface RouteModule {
  action?: (args: {
    request: Request;
    params: Record<string, string>;
    context: unknown;
  }) => Promise<Response>;
}

const files = readdirSync("app/routes")
  .filter((f) => f.startsWith("api.") && f.endsWith(".ts"))
  .sort();

/** 入口を通ったか。405 ならその応答、通ってしまったなら null。 */
async function probe(
  mod: RouteModule,
  method: string,
): Promise<Response | null> {
  let res: Response;
  try {
    res = await mod.action!({
      request: new Request("https://example.test/api/x", { method }),
      params: { id: "x", mid: "y" },
      context: {} as unknown,
    });
  } catch {
    // 入口の先で落ちた（バインディングに触った等）＝断られてはいない
    return null;
  }
  return res.status === 405 ? res : null;
}

/** action を持っていたルート。 */
const withAction = new Set<string>();
/** 実際に何かのメソッドを断ったルート。 */
const guarded = new Set<string>();

describe("APIのメソッドの扱い", () => {
  it("ルートを読めている（0件なら以下は何も検査していない）", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const name = file.replace(/\.ts$/, "");

    it(`${name}`, async () => {
      const mod = (await import(`../../app/routes/${name}.ts`)) as RouteModule;
      if (!mod.action) return; // loader だけのルート（GETのみ）
      withAction.add(name);

      const passed: string[] = [];
      let allow: string | null = null;

      for (const method of VOCABULARY) {
        const rejection = await probe(mod, method);
        if (!rejection) {
          passed.push(method);
          continue;
        }
        guarded.add(name);
        allow = rejection.headers.get("Allow");
        // 断るときも、理由は同じ形で返す
        expect(await rejection.json()).toEqual({ error: expect.any(String) });
      }

      expect(allow, `${name}: 405 に Allow が無い`).toBeTruthy();
      // 名乗った受け口と、実際に通った受け口が一致すること
      expect(
        allow!
          .split(",")
          .map((m) => m.trim())
          .sort(),
        `${name}: 名乗りと実際がずれている`,
      ).toEqual([...passed].sort());

      // 更新は PATCH に揃える。PUT は役割が重なるので使わない
      expect(passed, `${name}: PUT を受けている`).not.toContain("PUT");
      // 同じ更新を2つの動詞で受けない
      expect(
        passed.includes("PATCH") && passed.includes("POST"),
        `${name}: PATCH と POST の両方を受けている`,
      ).toBe(false);
    });
  }

  /**
   * 失敗の返し方をひとつに寄せる。素の Response.json を書くと、形
   * （{error} かどうか）も状態コードも各ルートの自由になり、呼ぶ側は
   * 「このルートは何を返すか」を1つずつ覚えることになる。
   */
  it("失敗はすべて apiError から返す", () => {
    const handWritten: string[] = [];
    for (const file of files) {
      readFileSync(`app/routes/${file}`, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (
            /Response\.json\(\s*\{\s*error/.test(line) ||
            /return new Response\("/.test(line)
          ) {
            handWritten.push(`app/routes/${file}:${i + 1}`);
          }
        });
    }
    expect(handWritten).toEqual([]);
  });

  /**
   * 上の it は action が無ければ素通りするので、読み込みに失敗しても
   * 全部通ってしまう。実際に何件を叩けたのかを数えておく。
   *
   * 「action を持つルートは、必ず何かのメソッドを断る」も一緒に見る。
   * 断らないルートが出たら、そこだけ入口の確認が外れたということ。
   */
  it("action を持つルートは、すべて入口で断っている", () => {
    expect(withAction.size).toBeGreaterThanOrEqual(15);
    expect([...withAction].filter((n) => !guarded.has(n))).toEqual([]);
  });
});
