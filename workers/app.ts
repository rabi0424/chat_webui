import { DurableObject } from "cloudflare:workers";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext } from "../app/lib/cloudflare-context";
import { finalizeGeneration, getMessage } from "../app/lib/db.server";
import {
  runGenerationJob,
  type GenerationJob,
} from "../app/lib/generation.server";

/**
 * バックグラウンド生成の実行体。
 *
 * 生成はDOの「アラームハンドラ」内で実行する。アラームは独立した
 * イベントとして完了まで実行が保証され（at-least-once）、リクエストや
 * クライアントの切断に寿命が引きずられない。waitUntil頼みの方式は
 * 本番環境で切断後に処理が落ちることがあったため廃止した。
 */
export class GenerationRunner extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const job = (await request.json()) as GenerationJob;
    await this.ctx.storage.put("job", job);
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return Response.json({ ok: true }, { status: 202 });
  }

  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<GenerationJob>("job");
    if (!job) return;
    try {
      const row = await getMessage(job.conversationId, job.assistantMessageId);
      if (row && row.status === "streaming") {
        if (row.content !== "") {
          // 前回の実行が途中で失われた後の再試行。二重課金を避けるため、
          // ここまでの部分内容で確定させる
          await finalizeGeneration(job.assistantMessageId, {
            content: row.content,
            reasoning: row.reasoning,
            usageJson: row.usage_json,
            status: "done",
            error: null,
          });
        } else {
          await runGenerationJob(job);
        }
      }
    } catch (e) {
      // 想定外の失敗は行を確定させてUIの固まりを防ぐ
      await finalizeGeneration(job.assistantMessageId, {
        content: "",
        reasoning: null,
        usageJson: null,
        status: "error",
        error: `生成処理が失敗しました: ${(e as Error).message}`,
      }).catch(() => {});
    }
    await this.ctx.storage.delete("job");
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
