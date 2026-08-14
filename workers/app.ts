import { DurableObject } from "cloudflare:workers";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext } from "../app/lib/cloudflare-context";
import { startGeneration } from "../app/lib/generation.server";

/**
 * バックグラウンド生成の実行体。
 *
 * Workerの waitUntil はクライアント切断後およそ30秒しか猶予がないため、
 * 生成はこのDurable Objectの中で実行する。DOは進行中の非同期処理がある
 * 限り生き続けるので、ブラウザを閉じても生成とD1への保存は完了まで続く。
 */
export class GenerationRunner extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as Parameters<typeof startGeneration>[0];
    const result = await startGeneration(body);
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status });
    }
    // DOを生成完了まで維持する
    this.ctx.waitUntil(result.done);
    return new Response(result.stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
