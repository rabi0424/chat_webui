import { defineConfig } from "vitest/config";

/**
 * テストの設定。
 *
 * 本体の vite.config.ts とは分ける。あちらは Cloudflare Workers 向けの
 * プラグインを噛ませていて、素の Node で動かすテストとは前提が違う。
 *
 * ここで見るのは「Workers のバインディング（D1・R2）に触らない」層に
 * 限る。純粋な変換・判定・組み立てが中心で、これらは実際にバグが
 * 出た場所でもある。DOMが要るものは tests/dom/ に置き、そちらだけ
 * happy-dom の上で動かす。
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/*.test.ts"],
          // localStorage を触るものがあるので DOM を用意する
          environment: "jsdom",
        },
      },
      {
        test: {
          name: "dom",
          include: ["tests/dom/*.test.ts"],
          environment: "jsdom",
        },
      },
    ],
  },
});
