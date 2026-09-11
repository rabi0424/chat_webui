// Secrets are not part of wrangler.jsonc "vars", so they are missing from the
// generated worker-configuration.d.ts Env. Merge them in here.
declare namespace Cloudflare {
  interface Env {
    OPENROUTER_API_KEY: string;
    /** 任意: 設定するとPoeのモデルが一覧に追加される。 */
    POE_API_KEY?: string;
    /** 任意: 設定すると API易 のモデルが使えるようになる。 */
    APIYI_API_KEY?: string;
    /**
     * API易 から一覧に載せるモデル名（カンマか空白区切り）。
     *
     * 中継は300本以上を扱うので、一覧へ丸ごと載せない。**キーだけを
     * 設定してここが空なら、API易のモデルは1本も出ない。**
     * モデル名をリポジトリへ置かないための入れ物でもある。
     */
    APIYI_MODELS?: string;
  }
}

/** ビルドの識別子（vite.config.ts の define で埋め込むgit短縮SHA）。 */
declare const __BUILD_ID__: string;
