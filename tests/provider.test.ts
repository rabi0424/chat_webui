import { describe, expect, it } from "vitest";
import {
  APIYI_PREFIX,
  MODEL_PREFIXES,
  POE_PREFIX,
  PROVIDER_LABELS,
  bareModelName,
  isApiyiModel,
  isPoeModel,
  providerOf,
  supportsWebSearch,
} from "../app/lib/constants";

/**
 * 窓口の判定。
 *
 * 窓口が2つだったころ、判定は `isPoeModel(id) ? "poe" : "openrouter"`
 * という形で台帳・画面・パラメータの組み立てに散っていた。3つ目を足す
 * とき、この形は**足し忘れても型では気づけない**（どちらも文字列を
 * 返すので、漏れた場所は黙って "openrouter" に落ちる）。判定を1か所に
 * 寄せたので、ここでその1か所を見る。
 */
describe("providerOf", () => {
  it("接頭辞で窓口が決まり、接頭辞が無ければ OpenRouter", () => {
    expect(providerOf(`${POE_PREFIX}Claude-Sonnet`)).toBe("poe");
    expect(providerOf(`${APIYI_PREFIX}some-model`)).toBe("apiyi");
    expect(providerOf("openai/gpt-4o-mini")).toBe("openrouter");
    expect(providerOf(null)).toBe("openrouter");
    expect(providerOf(undefined)).toBe("openrouter");
  });

  it("接頭辞は先頭でなければ効かない", () => {
    expect(providerOf(`x-${POE_PREFIX}y`)).toBe("openrouter");
    expect(providerOf(`x-${APIYI_PREFIX}y`)).toBe("openrouter");
  });

  it("接頭辞を外すと、上流へ投げるモデル名になる", () => {
    expect(bareModelName(`${POE_PREFIX}GPT-Image-2`)).toBe("GPT-Image-2");
    expect(bareModelName(`${APIYI_PREFIX}a/b:c`)).toBe("a/b:c");
    // 接頭辞が無いIDは、スラッシュを含んでいてもそのまま
    expect(bareModelName("openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
  });

  it("窓口ごとの判定は providerOf と食い違わない", () => {
    for (const [provider, prefix] of MODEL_PREFIXES) {
      const id = `${prefix}model`;
      expect(providerOf(id)).toBe(provider);
      expect(isPoeModel(id)).toBe(provider === "poe");
      expect(isApiyiModel(id)).toBe(provider === "apiyi");
    }
  });

  it("表示名はどの窓口にもある（未定義のまま画面に出さない）", () => {
    for (const [provider] of MODEL_PREFIXES) {
      expect(PROVIDER_LABELS[provider]).toBeTruthy();
    }
    expect(PROVIDER_LABELS.openrouter).toBeTruthy();
  });
});

describe("supportsWebSearch", () => {
  /*
   * Web検索は OpenRouter 固有の機能。「Poe ではない」で判定していると、
   * 窓口が増えたときに送っても効かないフラグが立つ（上流によっては
   * 知らないフィールドとして 400 になる）。
   */
  it("OpenRouter のモデルだけが使える", () => {
    expect(supportsWebSearch("openai/gpt-4o-mini")).toBe(true);
    expect(supportsWebSearch(`${POE_PREFIX}Claude-Sonnet`)).toBe(false);
    expect(supportsWebSearch(`${APIYI_PREFIX}some-model`)).toBe(false);
  });
});
