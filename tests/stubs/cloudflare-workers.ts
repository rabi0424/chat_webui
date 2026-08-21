/**
 * `cloudflare:workers` の代わり。
 *
 * サーバー側のモジュールはこれを読むので、素の Node からは import した
 * だけで落ちる。中身が要らない（バインディングに触らない部分だけを
 * 試したい）場面のために、空の入れ物を置いておく。
 *
 * これを使うテストは「バインディングを使わない経路」に限ること。
 * D1 や R2 に触る道を通すと、ここで用意した空の env が原因の
 * 分かりにくい失敗になる。
 */
export const env = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(
        `テストからバインディング env.${String(prop)} に触れました。` +
          `この経路はバインディングを使わない前提です。`,
      );
    },
  },
) as Record<string, unknown>;

export class DurableObject {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, e: unknown) {
    this.ctx = ctx;
    this.env = e;
  }
}
