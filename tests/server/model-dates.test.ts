import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * モデルの公開日の単位。
 *
 * OpenRouter の `created` は秒、Poe は同じ名前でミリ秒を返す。Poe の値を
 * 秒として扱っていたせいで、新着の判定では数万年先の日付になり、Poe の
 * モデルには新着の印が一度も付かなかった。新しいモデルは名前順で一覧の
 * 末尾に埋もれ、「Poe の一覧が更新されない」ように見えていた。
 *
 * 単位の変換だけを見ても、判定の側が秒を前提にしていることとの結び付きは
 * 見張れない。取得から判定までを通して確かめる。
 */
vi.mock("cloudflare:workers", () => ({
  env: { POE_API_KEY: "poe-key" },
  DurableObject: class {},
}));

const { fetchModels, epochSeconds } = await import(
  "../../app/lib/openrouter.server"
);
const { isNewModel } = await import("../../app/components/ModelPicker");

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("公開日を秒へそろえる", () => {
  it("ミリ秒は秒に直し、秒はそのまま通す", () => {
    expect(epochSeconds(1790702517392)).toBe(1790702517);
    expect(epochSeconds(1790702517)).toBe(1790702517);
  });

  it("読めない値は日付不明（0）", () => {
    expect(epochSeconds(undefined)).toBe(0);
    expect(epochSeconds("abc")).toBe(0);
    expect(epochSeconds(-5)).toBe(0);
  });
});

describe("Poe の新しいモデルに新着の印が付く", () => {
  it("昨日公開の Poe（ミリ秒）と OpenRouter（秒）の両方が新着になる", async () => {
    const now = Date.now();
    const yesterdayMs = now - DAY_MS;
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.poe.com/v1/models")) {
        return Promise.resolve(
          Response.json({
            data: [
              { id: "fresh-bot", created: yesterdayMs },
              { id: "old-bot", created: now - 400 * DAY_MS },
            ],
          }),
        );
      }
      if (url.startsWith("https://openrouter.ai/api/v1/models")) {
        return Promise.resolve(
          Response.json({
            data: [{ id: "vendor/fresh", created: Math.floor(yesterdayMs / 1000) }],
          }),
        );
      }
      return Promise.reject(new Error(`想定外の宛先: ${url}`));
    });

    const models = await fetchModels();
    const byId = new Map(models.map((m) => [m.id, m]));
    const fresh = byId.get("poe:fresh-bot");
    const old = byId.get("poe:old-bot");
    const openrouter = byId.get("vendor/fresh");
    // 一覧に入っていること自体を先に確かめる（無ければ下の false は空振り）
    expect(fresh).toBeDefined();
    expect(old).toBeDefined();
    expect(openrouter).toBeDefined();

    expect(isNewModel(fresh!, now, 3)).toBe(true);
    expect(isNewModel(openrouter!, now, 3)).toBe(true);
    // 古いものまで新着にしてしまう直し方（判定を緩める等）は通さない
    expect(isNewModel(old!, now, 3)).toBe(false);
  });
});
