import { DurableObject } from "cloudflare:workers";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext } from "../app/lib/cloudflare-context";
import { finalizeGeneration, getMessage } from "../app/lib/db.server";
import {
  runGenerationJob,
  type GenerationJob,
  type RetryRunState,
} from "../app/lib/generation.server";

/** 途中経過の保存先。これがあれば「続きの実行」だと分かる。 */
const STATE_KEY = "retryState";
/** 続きのアラームを入れるまでの間隔。すぐ次を走らせたいので最小限。 */
const NEXT_CHUNK_MS = 50;

/**
 * バックグラウンド生成の実行体。
 *
 * 生成はDOの「アラームハンドラ」内で実行する。アラームは独立した
 * イベントとして完了まで実行が保証され（at-least-once）、リクエストや
 * クライアントの切断に寿命が引きずられない。waitUntil頼みの方式は
 * 本番環境で切断後に処理が落ちることがあったため廃止した。
 *
 * 「成功するまで生成」は1回のアラームでは終わらないことがある。
 * Workers は1回の呼び出しで出せるサブリクエストの数に上限があり
 * （無料プランでは外部への fetch が50件）、何十本も投げるこのモードは
 * それに届く。生成側は上限の手前で切り上げて途中経過を返すので、
 * ここで保存して次のアラームを入れ、続きを走らせる。アラームは
 * 呼び出しが別なので、そのたびにサブリクエストの枠が戻る。
 */
export class GenerationRunner extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const job = (await request.json()) as GenerationJob;
    await this.ctx.storage.put("job", job);
    // 新しいジョブなので、前のジョブの残骸が居たら捨てる
    await this.ctx.storage.delete(STATE_KEY);
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return Response.json({ ok: true }, { status: 202 });
  }

  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<GenerationJob>("job");
    if (!job) return;
    const state = (await this.ctx.storage.get<RetryRunState>(STATE_KEY)) ?? null;
    try {
      const row = await getMessage(job.conversationId, job.assistantMessageId);
      if (row && row.status === "streaming") {
        // 続きの実行では見出しに進捗が入っているので、中断とは見なさない
        if (!state && row.content !== "") {
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
          const outcome = await runGenerationJob(job, state);
          if (!outcome.done) {
            // サブリクエストの枠を使い切った。続きは次のアラームで
            await this.ctx.storage.put(STATE_KEY, outcome.state);
            await this.ctx.storage.setAlarm(Date.now() + NEXT_CHUNK_MS);
            return;
          }
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
    await this.ctx.storage.delete(STATE_KEY);
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
