// Secrets are not part of wrangler.jsonc "vars", so they are missing from the
// generated worker-configuration.d.ts Env. Merge them in here.
declare namespace Cloudflare {
  interface Env {
    OPENROUTER_API_KEY: string;
    /** 任意: 設定するとPoeのモデルが一覧に追加される。 */
    POE_API_KEY?: string;
  }
}

/** ビルドの識別子（vite.config.ts の define で埋め込むgit短縮SHA）。 */
declare const __BUILD_ID__: string;
