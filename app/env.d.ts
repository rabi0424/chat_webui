// Secrets are not part of wrangler.jsonc "vars", so they are missing from the
// generated worker-configuration.d.ts Env. Merge them in here.
declare namespace Cloudflare {
  interface Env {
    OPENROUTER_API_KEY: string;
  }
}
