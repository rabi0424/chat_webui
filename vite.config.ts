import { execSync } from "node:child_process";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * ビルドの識別子（gitの短縮SHA）。遷移時間の記録に付けて、
 * どのデプロイの数字かを自動で区別できるようにする（lib/perf.ts）。
 */
let buildId = "dev";
try {
  buildId = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  // gitのない環境ではdevのまま
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
