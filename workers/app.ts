import { DurableObject } from "cloudflare:workers";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext } from "../app/lib/cloudflare-context";
import { finalizeGeneration, getMessage } from "../app/lib/db.server";
import { isRetryProgress } from "../app/lib/retry";
import { crossSiteReason } from "../app/lib/same-origin";
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
 * ジョブを分割して置くときの1片の大きさ（文字数）と、置き場の名前。
 *
 * ジョブにはモデルへ送る履歴が丸ごと入っていて、長い会話ではひとつの
 * 値として収まらないことがある（DOストレージには1値あたりの上限が
 * ある）。収まらないと put が例外を投げ、生成が始まらないまま
 * プレースホルダだけが残る。上限に依存しないよう、常に分けて置く。
 *
 * 数えるのは文字数だが、上限はバイト数で決まる。日本語はUTF-8で
 * 1文字3バイトなので、最悪でも 30,000 × 3 = 約88KiB に収まる幅にする。
 */
const JOB_CHUNK_CHARS = 30_000;
const JOB_CHUNK_PREFIX = "job:";
const JOB_CHUNK_COUNT_KEY = "jobChunks";
/** 1回の get/put/delete でまとめて扱えるキーの数。 */
const STORAGE_KEY_BATCH = 100;

function chunkKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${JOB_CHUNK_PREFIX}${i}`);
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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
  /** ジョブを分割して保存する（1値の上限に引っかからないように）。 */
  private async putJob(job: GenerationJob): Promise<void> {
    const text = JSON.stringify(job);
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += JOB_CHUNK_CHARS) {
      parts.push(text.slice(i, i + JOB_CHUNK_CHARS));
    }
    await this.clearJob();
    for (const group of batches(
      parts.map((value, i) => [`${JOB_CHUNK_PREFIX}${i}`, value] as const),
      STORAGE_KEY_BATCH,
    )) {
      await this.ctx.storage.put(Object.fromEntries(group));
    }
    // 数は最後に書く。途中で落ちても「半分だけのジョブ」を読まないため
    await this.ctx.storage.put(JOB_CHUNK_COUNT_KEY, parts.length);
  }

  /** 分割して置いたジョブを読み戻す。 */
  private async getJob(): Promise<GenerationJob | null> {
    const count = await this.ctx.storage.get<number>(JOB_CHUNK_COUNT_KEY);
    if (typeof count !== "number") {
      // 分割前の版が置いたジョブが残っていることがある
      return (await this.ctx.storage.get<GenerationJob>("job")) ?? null;
    }
    let text = "";
    for (const group of batches(chunkKeys(count), STORAGE_KEY_BATCH)) {
      const found = await this.ctx.storage.get<string>(group);
      for (const key of group) {
        const part = found.get(key);
        if (typeof part !== "string") return null; // 欠けていれば読まない
        text += part;
      }
    }
    try {
      return JSON.parse(text) as GenerationJob;
    } catch {
      return null;
    }
  }

  /** ジョブの置き場を空にする。 */
  private async clearJob(): Promise<void> {
    const count = await this.ctx.storage.get<number>(JOB_CHUNK_COUNT_KEY);
    await this.ctx.storage.delete(JOB_CHUNK_COUNT_KEY);
    if (typeof count === "number") {
      for (const group of batches(chunkKeys(count), STORAGE_KEY_BATCH)) {
        await this.ctx.storage.delete(group);
      }
    }
    await this.ctx.storage.delete("job");
  }

  override async fetch(request: Request): Promise<Response> {
    const job = (await request.json()) as GenerationJob;
    await this.putJob(job);
    // 新しいジョブなので、前のジョブの残骸が居たら捨てる
    await this.ctx.storage.delete(STATE_KEY);
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return Response.json({ ok: true }, { status: 202 });
  }

  override async alarm(): Promise<void> {
    const job = await this.getJob();
    if (!job) return;
    const state = (await this.ctx.storage.get<RetryRunState>(STATE_KEY)) ?? null;
    try {
      const row = await getMessage(job.conversationId, job.assistantMessageId);
      if (row && row.status === "streaming") {
        // 続きの実行では見出しに進捗が入っているので、中断とは見なさない
        if (!state && row.content !== "") {
          // 前回の実行が途中で失われた後の再試行。二重課金を避けるため、
          // ここまでの部分内容で確定させる。
          //
          // ただし本文が進捗の見出し（「生成中… 成功 x/y」）のときは、
          // それは応答ではなく実行の途中経過なので、そのまま done に
          // すると偽の「生成中…」が会話に残り続ける。リトライ生成では
          // 見出しの下に成功した応答が既に積まれているので、見出しは
          // 中断として確定させて、利用者が再試行できるようにする
          const interrupted = isRetryProgress(row.content);
          await finalizeGeneration(job.assistantMessageId, {
            content: interrupted ? "" : row.content,
            reasoning: interrupted ? null : row.reasoning,
            usageJson: interrupted ? null : row.usage_json,
            status: interrupted ? "error" : "done",
            error: interrupted
              ? "生成が中断されました。下に残っている応答はそのまま使えます。再試行してください。"
              : null,
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
      // 想定外の失敗は行を確定させてUIの固まりを防ぐ。
      // ここまで書けていた分は消さない（部分的でも課金済みの成果で、
      // 空で塗りつぶすと利用者から見て何も残らない）
      const partial = await getMessage(
        job.conversationId,
        job.assistantMessageId,
      ).catch(() => null);
      const keep = partial && !isRetryProgress(partial.content) ? partial : null;
      await finalizeGeneration(job.assistantMessageId, {
        content: keep?.content ?? "",
        reasoning: keep?.reasoning ?? null,
        usageJson: keep?.usage_json ?? null,
        status: "error",
        error: `生成処理が失敗しました: ${(e as Error).message}`,
      }).catch(() => {});
    }
    await this.clearJob();
    await this.ctx.storage.delete(STATE_KEY);
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    // 別のサイトからの書き換えはここで断つ。ルートは17本あり、
    // 1本ずつ足すと足し忘れがそのまま穴になるので、入口で一度だけ見る
    const reason = crossSiteReason(request);
    if (reason) {
      console.warn(`[security] クロスサイトの書き換えを断りました: ${reason}`);
      return Response.json(
        { error: "このサイト以外からの操作は受け付けません" },
        { status: 403 },
      );
    }
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
