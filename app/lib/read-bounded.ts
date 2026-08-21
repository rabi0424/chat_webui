/**
 * 応答の本文を、上限までしか読まない。
 *
 * 生成の本体（generation.server.ts）から切り出してある。あちらは
 * cloudflare:workers を読むので Workers の外からは触れないが、
 * これは Response を読むだけの処理でしかない。
 */

/**
 * 上限までしか読まない。超えたらそこで打ち切って捨てる。
 *
 * arrayBuffer() は本文を最後まで受け取ってから返すので、大きさの検査が
 * そのあとでは遅い——上限を超えていると分かるころには、超えたぶんを
 * すべてメモリに載せている。長さを申告しない上流もあるので、読みながら
 * 数える。
 */
export async function readBounded(
  res: Response,
  limit: number,
): Promise<ArrayBuffer | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

