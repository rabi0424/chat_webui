import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ヘッダを待つタイムアウトが、本文のストリームまで切っていないか。
 *
 * 上流への fetch には「ヘッダが返るまで」の見張りが要る（接続だけ張って
 * 何も返さない上流に当たると、生成の実行がそこで永久に止まるため）。
 * これを `signal: AbortSignal.timeout(...)` で書くと、signal はヘッダを
 * 受け取っても外れず本文にも効いたままになり、**60秒を超える生成が
 * 順調に流れている最中に切られる**。利用者からは
 * 「応答が途中で終わりました（The operation was aborted due to timeout）」
 * と見えていた。
 *
 * ソースを読んでも「signal がどこまで効くか」は分からない。実際に遅い
 * ストリームを流して、締め切りを跨いでも最後まで読めることを見る。
 */
vi.mock("cloudflare:workers", () => ({
  env: { POE_API_KEY: "test-key", OPENROUTER_API_KEY: "test-key" },
  DurableObject: class {},
}));

const { poeChatRequest, openRouterChatRequest } = await import(
  "../../app/lib/openrouter.server"
);

/** ヘッダを待つ上限。テストのあいだだけ縮める。 */
const CONNECT_TIMEOUT_MS = 200;
/** 1チャンクの間隔と本数。合計はタイムアウトを確実に跨ぐ長さにする。 */
const CHUNK_INTERVAL_MS = 100;
const CHUNK_COUNT = 6;

let server: http.Server;
let origin = "";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    // ヘッダを返さないまま黙り込む上流。見張りが効かなければ永久に待つ
    if (req.url === "/silent") return;

    // ヘッダはすぐ返し、本文だけをゆっくり流す上流
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let n = 0;
    const timer = setInterval(() => {
      res.write(`data: chunk-${n}\n\n`);
      if (++n >= CHUNK_COUNT) {
        clearInterval(timer);
        res.end();
      }
    }, CHUNK_INTERVAL_MS);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 上流の宛先だけを差し替える。init（＝見張りの signal を含む）はそのまま
 * 渡すので、production が組み立てた signal の効き方をそのまま試せる。
 */
function routeTo(path: string) {
  vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) =>
    realFetch(`${origin}${path}`, init),
  );
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("上流へのリクエストの見張り", () => {
  it.each([
    ["poeChatRequest", poeChatRequest],
    ["openRouterChatRequest", openRouterChatRequest],
  ])("%s: 締め切りを跨いでも本文は最後まで読める", async (_name, request) => {
    routeTo("/slow");
    const started = Date.now();
    const res = await request({}, CONNECT_TIMEOUT_MS);
    const text = await readAll(res);
    const elapsed = Date.now() - started;

    // 締め切りを跨いでいなければ、この試験は何も見ていない
    expect(elapsed).toBeGreaterThan(CONNECT_TIMEOUT_MS);
    for (let i = 0; i < CHUNK_COUNT; i++) {
      expect(text).toContain(`data: chunk-${i}\n`);
    }
  });

  it("ヘッダが返らない上流は、見張りが打ち切る", async () => {
    routeTo("/silent");
    await expect(poeChatRequest({}, CONNECT_TIMEOUT_MS)).rejects.toThrow(
      "上流が応答ヘッダを返しませんでした",
    );
  });
});
