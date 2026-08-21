import { defineConfig } from "vitest/config";

/**
 * テストの設定。
 *
 * 本体の vite.config.ts とは分ける。あちらは Cloudflare Workers 向けの
 * プラグインを噛ませていて、素の Node で動かすテストとは前提が違う。
 *
 * ここで見るのは「Workers のバインディング（D1・R2）に触らない」層に
 * 限る。純粋な変換・判定・組み立てが中心で、これらは実際にバグが
 * 出た場所でもある。DOMが要るものは tests/dom/ に置く。
 *
 * スキーマだけは素の Node で走らせる。node:sqlite に本物の SQL を
 * 流したいが、jsdom 向けの束ね方では Node の組み込みを読めないため。
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/*.test.ts"],
          exclude: ["tests/schema.test.ts", "tests/touch-variant.test.ts"],
          // localStorage を触るものがあるので DOM を用意する
          environment: "jsdom",
        },
      },
      {
        // サーバー側のモジュール（cloudflare:workers を読むもの）のうち、
        // バインディングに触らない部分を試す
        resolve: {
          alias: {
            "cloudflare:workers": new URL(
              "./tests/stubs/cloudflare-workers.ts",
              import.meta.url,
            ).pathname,
          },
        },
        test: {
          name: "server",
          include: ["tests/server/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "schema",
          include: ["tests/schema.test.ts"],
          // node:sqlite を読むので、DOM を被せない
          environment: "node",
        },
      },
      {
        test: {
          name: "css",
          // ビルド結果の CSS を読むので、素の Node で
          include: ["tests/touch-variant.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "dom",
          include: ["tests/dom/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["tests/dom/setup.ts"],
        },
      },
    ],
  },
});
