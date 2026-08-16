import {
  fetchPoeRecentPoints,
  fetchPoeRunPoints,
  openRouterChatRequest,
  poeChatRequest,
  POE_PREFIX,
  type ChatMessage,
} from "./openrouter.server";
import { buildGenerationPayload, type ParamsState } from "./params";
import { RETRY_RATE_LIMIT_ROUNDS, type RetryConfig } from "./retry";
import {
  appendAssistantMessage,
  createGeneratedAttachment,
  finalizeGeneration,
  flushGeneration,
  getAttachments,
} from "./db.server";
import {
  ALLOWED_IMAGE_TYPES,
  getFile,
  isStorageConfigured,
  putFile,
  toBase64,
} from "./r2.server";

/**
 * サーバー側生成のジョブ実行。
 *
 * Durable Object のアラームハンドラ内から呼ばれ、上流（OpenRouter）の
 * SSEを読みながら一定間隔でD1へ部分保存し、終了時に確定させる。
 * クライアントへの直接中継は行わず、すべての画面がD1のポーリングで
 * 生成過程を閲覧する（イベントとして完了まで実行が保証される）。
 */

const FLUSH_INTERVAL_MS = 900;

/** OpenAI互換のマルチモーダルコンテンツ要素。 */
type ContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | {
      type: "image_url";
      image_url: { url: string };
      cache_control?: { type: "ephemeral" };
    };

interface OutgoingMessage {
  role: string;
  content: string | ContentPart[];
}

/**
 * 添付画像を data: URL へ展開する。
 *
 * アプリは Cloudflare Access の背後にあり、外部（LLMプロバイダ）から
 * 画像URLを取得させられないため、実体をbase64で埋め込んで送る。
 * 読み出せなかった画像は黙って除外する（残りのやり取りは成立させる）。
 */
async function expandAttachments(
  messages: ChatMessage[],
): Promise<OutgoingMessage[]> {
  const out: OutgoingMessage[] = [];
  for (const m of messages) {
    if (!m.attachmentIds || m.attachmentIds.length === 0) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const rows = await getAttachments(m.attachmentIds);
    const parts: ContentPart[] = [];
    for (const a of rows) {
      try {
        const object = await getFile(a.r2_key);
        if (!object) continue;
        const url = `data:${a.mime_type};base64,${toBase64(
          await object.arrayBuffer(),
        )}`;
        parts.push({ type: "image_url", image_url: { url } });
      } catch {
        // 1枚読めなくても送信自体は続ける
      }
    }
    // 画像 → テキストの順（Anthropicの推奨。他社も同等に扱う）
    if (m.content) parts.push({ type: "text", text: m.content });
    out.push({
      role: m.role,
      content: parts.length > 0 ? parts : m.content,
    });
  }
  return out;
}

/**
 * プロンプトキャッシングの適用。
 *
 * OpenAI / Gemini / DeepSeek などは自動でキャッシュされるが、
 * Anthropic (Claude) は cache_control ブレークポイントの明示が必要。
 * チャットは毎ターン同じ履歴を先頭から送り直すため、
 * システムプロンプトと直近2つのユーザーメッセージに印を付けると
 * 前ターンまでの前置きがキャッシュ読取（0.1倍課金）になる。
 */
function applyPromptCaching(
  model: string,
  messages: OutgoingMessage[],
): OutgoingMessage[] {
  if (!model.startsWith("anthropic/")) return messages;

  const marked = new Set<number>();
  messages.forEach((m, i) => {
    if (m.role === "system") marked.add(i);
  });
  let userMarks = 0;
  for (let i = messages.length - 1; i >= 0 && userMarks < 2; i--) {
    if (messages[i].role === "user") {
      marked.add(i);
      userMarks++;
    }
  }

  return messages.map((m, i) => {
    if (!marked.has(i)) return m;
    // ブレークポイントは末尾の要素に置く（そこまでの全内容がキャッシュ対象）
    const parts: ContentPart[] =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : [...m.content];
    if (parts.length === 0) return m;
    parts[parts.length - 1] = {
      ...parts[parts.length - 1],
      cache_control: { type: "ephemeral" },
    };
    return { role: m.role, content: parts };
  });
}

/** 画像一覧の検索に使う、この生成の依頼文（直近のユーザー発言）。 */
function promptOf(job: GenerationJob): string | null {
  for (let i = job.messages.length - 1; i >= 0; i--) {
    const m = job.messages[i];
    if (m.role === "user" && m.content.trim()) return m.content;
  }
  return null;
}

/** 1応答あたりに取り込む生成画像の枚数と、1枚あたりの上限。 */
const MAX_CAPTURED_IMAGES = 8;
const MAX_CAPTURED_BYTES = 20 * 1024 * 1024;

/**
 * OpenAI互換の応答に載る生成画像を取り出す。
 *
 * OpenRouterの画像生成モデルは本文ではなく `images` フィールドで返し、
 * 中身は base64 の data: URL。要素の形は
 * `{ type: "image_url", image_url: { url } }` だが、素の文字列や
 * `{ url }` で来る実装もあるため、いずれも受ける。
 */
function collectImageUrls(value: unknown, into: string[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const obj = item as { image_url?: { url?: unknown }; url?: unknown } | null;
    const url =
      typeof item === "string"
        ? item
        : typeof obj?.image_url?.url === "string"
          ? obj.image_url.url
          : typeof obj?.url === "string"
            ? obj.url
            : null;
    if (url && !into.includes(url)) into.push(url);
  }
}

/** 応答本文からモデルが返した画像URLを拾う（markdown記法と裸のURL）。 */
function extractImageUrls(content: string): string[] {
  const urls: string[] = [];
  const add = (u: string) => {
    if (u.startsWith("http") && !urls.includes(u)) urls.push(u);
  };
  for (const m of content.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
    add(m[1]);
  }
  // 画像記法を使わず、URLだけを返すボットもある
  for (const m of content.matchAll(/https?:\/\/[^\s<>()[\]"']+/g)) {
    if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(m[0])) add(m[0]);
  }
  return urls.slice(0, MAX_CAPTURED_IMAGES);
}

/** base64のdata: URLを実体へ戻す。Workersのfetchは data: を扱わない。 */
function decodeDataUrl(
  url: string,
): { buffer: ArrayBuffer; mimeType: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m) return null;
  const mimeType = m[1].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) return null;
  try {
    const binary = atob(m[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { buffer: bytes.buffer, mimeType };
  } catch {
    return null;
  }
}

/** 画像1枚をR2へ保存し、添付IDを返す。取り込めなければ null。 */
async function storeImage(
  url: string,
  target: { messageId: string; conversationId: string; prompt: string | null },
): Promise<string | null> {
  try {
    let payload: { buffer: ArrayBuffer; mimeType: string } | null = null;
    if (url.startsWith("data:")) {
      payload = decodeDataUrl(url);
    } else {
      const res = await fetch(url);
      if (!res.ok) return null;
      const mimeType = (res.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) return null;
      payload = { buffer: await res.arrayBuffer(), mimeType };
    }
    if (
      !payload ||
      payload.buffer.byteLength === 0 ||
      payload.buffer.byteLength > MAX_CAPTURED_BYTES
    ) {
      return null;
    }

    const key = `generated/${target.messageId}/${crypto.randomUUID()}`;
    await putFile(key, payload.buffer, payload.mimeType);
    return await createGeneratedAttachment({
      messageId: target.messageId,
      conversationId: target.conversationId,
      r2Key: key,
      mimeType: payload.mimeType,
      name: null,
      size: payload.buffer.byteLength,
      prompt: target.prompt,
    });
  } catch {
    return null;
  }
}

/**
 * 生成された画像をR2へ取り込み、本文から参照できるようにする。
 *
 * 画像の返し方はプロバイダで違う。Poeは本文に上流CDN（pfst.cf2.poecdn.net）
 * のURLを書いて返し、そのURLは期限が切れると過去の会話から画像が消える。
 * OpenRouterは本文ではなく images フィールドに base64 の data: URL を載せる
 * ため、取り込まないとそもそも表示できない。どちらも実体をこちらへ持ち、
 * 添付として記録して会話にも画像一覧にも残るようにする。
 *
 * 本文中のURLは自前の配信URLへ差し替え、本文に出てこない画像は末尾へ
 * 画像記法で足す。取り込めなかったものは元のURLのまま残す。
 */
async function captureGeneratedImages(
  content: string,
  imageUrls: string[],
  target: { messageId: string; conversationId: string; prompt: string | null },
): Promise<string> {
  if (!isStorageConfigured()) return content;

  let out = content;
  for (const url of extractImageUrls(content)) {
    const id = await storeImage(url, target);
    if (id) out = out.split(url).join(`/api/files/${id}`);
  }
  for (const url of imageUrls.slice(0, MAX_CAPTURED_IMAGES)) {
    const id = await storeImage(url, target);
    if (id) out += `${out ? "\n\n" : ""}![生成画像](/api/files/${id})`;
  }
  return out;
}

export interface GenerationJob {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  web: boolean;
  /** 画像を出力できるモデルか（OpenRouterでは modalities の指定が要る）。 */
  imageOutput?: boolean;
  /** 成功するまで生成するモード。無効なら undefined。 */
  retry?: RetryConfig;
  paramsState: ParamsState | null;
  messages: ChatMessage[];
}

/** 例外を投げず、必ずメッセージ行を確定させて終了する。 */
/** 上流へのリクエスト。プロバイダごとの差はここに閉じる。 */
async function requestUpstream(
  job: GenerationJob,
  messages: OutgoingMessage[],
): Promise<Response> {
  const isPoe = job.model.startsWith(POE_PREFIX);
  const modelName = isPoe ? job.model.slice(POE_PREFIX.length) : job.model;
  // Web検索プラグイン（:online）はOpenRouter専用
  const model = !isPoe && job.web ? `${modelName}:online` : modelName;

  return isPoe
    ? await poeChatRequest({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...buildGenerationPayload(job.paramsState, "poe"),
      })
    : await openRouterChatRequest({
        model,
        messages: applyPromptCaching(job.model, messages),
        stream: true,
        usage: { include: true },
        // 画像を出せるモデルでも、明示しないとテキストしか返らない
        ...(job.imageOutput ? { modalities: ["image", "text"] } : {}),
        ...buildGenerationPayload(job.paramsState, "openrouter"),
      });
}

/** 上流のエラー応答から、利用者に見せる文言を組み立てる。 */
async function upstreamErrorMessage(
  upstream: Response,
  isPoe: boolean,
): Promise<string> {
  let detail = "";
  try {
    const err = (await upstream.json()) as { error?: { message?: string } };
    detail = err.error?.message ?? "";
  } catch {
    // ステータスコードだけで十分
  }
  // 上流が知らないパラメータを弾いたときは、英語のメッセージだけでは
  // 何を直せばいいか分からないので、設定パネルへ誘導する
  const hint = /unknown parameter|unsupported parameter/i.test(detail)
    ? "\nこのモデルが対応していないパラメータが含まれています。⚙の生成パラメータを見直してください。"
    : "";
  return (
    (detail || `${isPoe ? "Poe" : "OpenRouter"} APIエラー (${upstream.status})`) +
    hint
  );
}

interface StreamResult {
  content: string;
  reasoning: string;
  usageJson: string | null;
  /** images フィールドで返ってきた生成画像（多くは data: URL）。 */
  imageUrls: string[];
  finishReason?: string;
  /** 停止要求で打ち切ったか。 */
  stopped: boolean;
}

/**
 * SSEを読み切る。
 *
 * onProgress は一定間隔で呼ばれ、true を返すと（停止要求）読み取りを
 * 打ち切る。リトライ生成では途中経過を保存しないので渡さない。
 */
async function readUpstreamStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (partial: {
    content: string;
    reasoning: string;
  }) => Promise<boolean>,
): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usageJson: string | null = null;
  let finishReason: string | undefined;
  const imageUrls: string[] = [];
  let stopped = false;
  let lastProgress = Date.now();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data: ")) continue;
        const data = line.slice("data: ".length);
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as {
            choices?: {
              delta?: {
                content?: string;
                reasoning?: string | null;
                images?: unknown;
              };
              message?: { images?: unknown };
              finish_reason?: string | null;
            }[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              cost?: number;
              prompt_tokens_details?: { cached_tokens?: number };
              completion_tokens_details?: { reasoning_tokens?: number };
            };
          };
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (typeof choice?.delta?.content === "string") {
            content += choice.delta.content;
          }
          if (typeof choice?.delta?.reasoning === "string") {
            reasoning += choice.delta.reasoning;
          }
          // 画像はストリーム中に delta で来るが、最後にまとめて
          // message で返す実装もある
          collectImageUrls(choice?.delta?.images, imageUrls);
          collectImageUrls(choice?.message?.images, imageUrls);
          if (chunk.usage) {
            usageJson = JSON.stringify({
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              cost: chunk.usage.cost,
              cachedTokens:
                chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined,
              reasoningTokens:
                chunk.usage.completion_tokens_details?.reasoning_tokens ??
                undefined,
            });
          }
        } catch {
          // 不正なチャンクは無視
        }
      }

      if (onProgress && Date.now() - lastProgress >= FLUSH_INTERVAL_MS) {
        lastProgress = Date.now();
        if (await onProgress({ content, reasoning })) {
          stopped = true;
          try {
            await reader.cancel();
          } catch {
            // 既に閉じている場合は無視
          }
          break;
        }
      }
    }
  } catch {
    // 上流の切断・エラー: ここまでの内容で確定する
  }

  return { content, reasoning, usageJson, imageUrls, finishReason, stopped };
}

/** 例外を投げず、必ずメッセージ行を確定させて終了する。 */
export async function runGenerationJob(job: GenerationJob): Promise<void> {
  if (job.retry) return await runRetryGenerationJob(job, job.retry);
  return await runSingleGeneration(job);
}

async function runSingleGeneration(job: GenerationJob): Promise<void> {
  const startedAt = Date.now();
  const isPoe = job.model.startsWith(POE_PREFIX);
  const modelName = isPoe ? job.model.slice(POE_PREFIX.length) : job.model;

  let upstream: Response;
  try {
    // 添付画像はここでR2から読み出して data: URL に展開する
    // （DOのストレージに実体を持ち込まないため、ジョブにはIDだけを載せている）
    upstream = await requestUpstream(job, await expandAttachments(job.messages));
  } catch (e) {
    await finalizeGeneration(job.assistantMessageId, {
      content: "",
      reasoning: null,
      usageJson: null,
      status: "error",
      error: `${isPoe ? "Poe" : "OpenRouter"}への接続に失敗しました: ${(e as Error).message}`,
    });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    await finalizeGeneration(job.assistantMessageId, {
      content: "",
      reasoning: null,
      usageJson: null,
      status: "error",
      error: await upstreamErrorMessage(upstream, isPoe),
    });
    return;
  }

  const result = await readUpstreamStream(upstream.body, async (partial) => {
    const { stopRequested } = await flushGeneration(job.assistantMessageId, {
      content: partial.content,
      reasoning: partial.reasoning || null,
    });
    return stopRequested;
  });
  let usageJson = result.usageJson;

  // Poe: ポイント消費はレスポンスに載らないため、Usage APIの履歴を
  // 突き合わせて usage に合流させる（履歴への反映が遅れることがあるので
  // 少し待ちながら数回試す。見つからなければ諦めて確定する）
  if (isPoe && result.content !== "") {
    for (const delay of [1200, 2500]) {
      await new Promise((r) => setTimeout(r, delay));
      const hit = await fetchPoeRecentPoints(modelName, startedAt);
      if (hit) {
        const base = usageJson
          ? (JSON.parse(usageJson) as Record<string, unknown>)
          : {};
        usageJson = JSON.stringify({
          ...base,
          points: hit.points,
          cost: hit.costUsd ?? base.cost,
        });
        break;
      }
    }
  }

  // 画像はここで自前のストレージへ移す（本文のURLも差し替わる）
  const finalContent =
    result.content === "" && result.imageUrls.length === 0
      ? result.content
      : await captureGeneratedImages(result.content, result.imageUrls, {
          messageId: job.assistantMessageId,
          conversationId: job.conversationId,
          prompt: promptOf(job),
        });
  // 画像だけの応答（本文なし）も成功として扱う
  const empty = finalContent === "";

  await finalizeGeneration(job.assistantMessageId, {
    content: finalContent,
    reasoning: result.reasoning || null,
    usageJson,
    status: empty ? "error" : "done",
    error: empty
      ? result.stopped
        ? "生成開始直後に停止されました"
        : `モデルから本文のない応答が返りました${
            result.finishReason ? `（finish_reason: ${result.finishReason}）` : ""
          }`
      : null,
  });
}

// --- 成功するまで生成する（リトライ生成） ---------------------------------

/** 生成中の見出しメッセージを更新する間隔。中断とみなされる前に打つ。 */
const HEARTBEAT_MS = 3_000;
/** レート制限に当たったときの待ち時間。 */
const RATE_LIMIT_BACKOFF_MS = [2_000, 4_000, 8_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 途中で起こせるスリープ。待ちっぱなしで次の処理を止めないため。 */
function cancellableSleep(ms: number): {
  promise: Promise<void>;
  cancel: () => void;
} {
  let cancel = () => {};
  const promise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, cancel };
}

type AttemptOutcome =
  | {
      kind: "success";
      content: string;
      usageJson: string | null;
      imageUrls: string[];
    }
  /** 画像が返らなかった応答。揺らぎの可能性があるので投げ直す対象。 */
  | { kind: "refused"; text: string }
  | { kind: "rate_limited" }
  | { kind: "error"; error: string };

/**
 * 1回分の生成。成功の判定は「画像が1枚以上あるか」だけで、
 * 拒否文の文言は見ない（言語や表現に依存して壊れるため）。
 */
async function runAttempt(
  job: GenerationJob,
  messages: OutgoingMessage[],
): Promise<AttemptOutcome> {
  const isPoe = job.model.startsWith(POE_PREFIX);
  let upstream: Response;
  try {
    upstream = await requestUpstream(job, messages);
  } catch (e) {
    return {
      kind: "error",
      error: `${isPoe ? "Poe" : "OpenRouter"}への接続に失敗しました: ${(e as Error).message}`,
    };
  }

  if (upstream.status === 429) {
    try {
      await upstream.body?.cancel();
    } catch {
      // 読み捨てるだけ
    }
    return { kind: "rate_limited" };
  }
  if (!upstream.ok || !upstream.body) {
    return { kind: "error", error: await upstreamErrorMessage(upstream, isPoe) };
  }

  const result = await readUpstreamStream(upstream.body);
  const hasImage =
    result.imageUrls.length > 0 || extractImageUrls(result.content).length > 0;
  return hasImage
    ? {
        kind: "success",
        content: result.content,
        usageJson: result.usageJson,
        imageUrls: result.imageUrls,
      }
    : { kind: "refused", text: result.content };
}

/** 見出しメッセージに出す進捗の文言。 */
function progressText(state: {
  successes: number;
  attempts: number;
  inflight: number;
  startedAt: number;
  retry: RetryConfig;
}): string {
  const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
  return (
    `生成中… 成功 ${state.successes}/${state.retry.target}・` +
    `試行 ${state.attempts}/${state.retry.maxAttempts}・` +
    `実行中 ${state.inflight}本（${elapsed}秒）`
  );
}

/**
 * 成功するまで生成するモード。
 *
 * 先頭に見出しのメッセージを1つ置き、その下に成功した応答を直列に
 * 積んでいく（左右の切り替えなしで全部見える）。見出しは実行中は進捗、
 * 終了後は結果の要約と拒否の内訳になる。成功は目標数を超えても捨てない
 * （並列に走っている分は既に課金されているため）。
 */
async function runRetryGenerationJob(
  job: GenerationJob,
  retry: RetryConfig,
): Promise<void> {
  const startedAt = Date.now();
  const isPoe = job.model.startsWith(POE_PREFIX);
  const modelName = isPoe ? job.model.slice(POE_PREFIX.length) : job.model;
  const statusId = job.assistantMessageId;

  let finished = false;
  let wakeHeartbeat = () => {};

  let messages: OutgoingMessage[];
  try {
    messages = await expandAttachments(job.messages);
  } catch (e) {
    await finalizeGeneration(statusId, {
      content: "",
      reasoning: null,
      usageJson: null,
      status: "error",
      error: `添付の読み出しに失敗しました: ${(e as Error).message}`,
    });
    return;
  }

  let attempts = 0;
  let successes = 0;
  let rateLimitRounds = 0;
  let stopped = false;
  /** レート制限に当たったら、この時刻まで新しい発射を控える。 */
  let pauseUntil = 0;
  let rateLimitExhausted = false;
  /** 成功はこの下に繋いでいく。 */
  let parentId = statusId;
  const refusals: string[] = [];
  let lastError: string | null = null;
  const inflight = new Set<Promise<void>>();

  /** 進捗の保存を兼ねた停止確認。 */
  const touch = async (): Promise<boolean> => {
    const { stopRequested } = await flushGeneration(statusId, {
      content: progressText({
        successes,
        attempts,
        inflight: inflight.size,
        startedAt,
        retry,
      }),
      reasoning: null,
    });
    if (stopRequested) stopped = true;
    return stopRequested;
  };

  /**
   * 結果の取り込みは1件ずつ直列に行う。
   * 成功は前の成功の下に繋ぐので、同時に走らせると親が競合する。
   */
  let queue: Promise<void> = Promise.resolve();
  const accept = (r: AttemptOutcome): Promise<void> => {
    queue = queue.then(async () => {
      if (r.kind === "rate_limited") {
        // レート制限は上流の都合なので試行回数は消費しない。
        // ただし待ち直しの回数には上限を設ける
        if (rateLimitRounds >= RETRY_RATE_LIMIT_ROUNDS) {
          lastError = "レート制限が続いたため打ち切りました";
          rateLimitExhausted = true;
          return;
        }
        pauseUntil =
          Date.now() +
          RATE_LIMIT_BACKOFF_MS[
            Math.min(rateLimitRounds, RATE_LIMIT_BACKOFF_MS.length - 1)
          ];
        rateLimitRounds++;
        return;
      }

      attempts++;
      if (r.kind === "error") {
        lastError = r.error;
      } else if (r.kind === "refused") {
        if (r.text.trim()) refusals.push(r.text.trim());
      } else {
        // 成功: 応答を1件足し、画像を自前のストレージへ移す。
        // 待たずにここで保存するので、実行中でも順に見えるようになる
        const id = await appendAssistantMessage({
          conversationId: job.conversationId,
          parentId,
          modelId: job.model,
          content: r.content,
          usageJson: r.usageJson,
        });
        const finalContent = await captureGeneratedImages(
          r.content,
          r.imageUrls,
          {
            messageId: id,
            conversationId: job.conversationId,
            prompt: promptOf(job),
          },
        );
        if (finalContent !== r.content) {
          await finalizeGeneration(id, {
            content: finalContent,
            reasoning: null,
            usageJson: r.usageJson,
            status: "done",
          });
        }
        parentId = id;
        successes++;
      }
      await touch();
    });
    return queue;
  };

  const launch = () => {
    const p = runAttempt(job, messages)
      .then(accept)
      .catch(() => {
        // 取り込みに失敗しても実行自体は続ける
      })
      .finally(() => {
        inflight.delete(p);
      });
    inflight.add(p);
  };

  /**
   * 空いた枠にすぐ次を発射し、1本終わるたびに取り込む。
   * バッチ単位で待つと、先に終わった成功が最も遅い1本に足を引っぱられる。
   */
  const heartbeat = (async () => {
    while (inflight.size > 0 || !stopped) {
      const nap = cancellableSleep(HEARTBEAT_MS);
      wakeHeartbeat = nap.cancel;
      await nap.promise;
      if (finished) break;
      await touch();
    }
  })();

  while (!stopped && !rateLimitExhausted) {
    if (Date.now() < pauseUntil) {
      await sleep(pauseUntil - Date.now());
      continue;
    }
    // 目標に届くまで、上限と並列数の範囲で発射し続ける
    while (
      !stopped &&
      successes < retry.target &&
      attempts + inflight.size < retry.maxAttempts &&
      inflight.size < retry.concurrency &&
      Date.now() >= pauseUntil
    ) {
      launch();
      await touch();
    }
    if (inflight.size === 0) break;
    await Promise.race(inflight);
  }

  // 走っている分は最後まで受け取る（課金済みなので成功は捨てない）
  await Promise.all(inflight);
  await queue;
  finished = true;
  wakeHeartbeat();
  await heartbeat;

  // Poe: 消費ポイントは応答に載らないので、実行時間帯の履歴を合計する
  let usageJson: string | null = null;
  if (isPoe && attempts > 0) {
    await sleep(1500);
    const total = await fetchPoeRunPoints(modelName, startedAt);
    if (total) {
      usageJson = JSON.stringify({ points: total.points, cost: total.costUsd });
    }
  }

  const lines: string[] = [];
  lines.push(
    stopped
      ? `**停止しました** — 成功 ${successes}件・試行 ${attempts}回`
      : `**完了** — 成功 ${successes}件（目標 ${retry.target}件）・試行 ${attempts}回（上限 ${retry.maxAttempts}回）`,
  );
  if (successes > retry.target) {
    lines.push(
      `目標より ${successes - retry.target}件多く受け取りました（並列で走っていた分です）。`,
    );
  }
  if (!stopped && successes < retry.target) {
    lines.push(
      `目標に届きませんでした（上限${attempts >= retry.maxAttempts ? "の試行回数" : ""}に達しました）。`,
    );
  }
  if (refusals.length > 0) {
    lines.push(`\n画像が返らなかった応答: ${refusals.length}回`);
    lines.push(
      `\n> ${refusals[0].slice(0, 300).replace(/\n+/g, " ")}${
        refusals[0].length > 300 ? "…" : ""
      }`,
    );
  }
  if (lastError) lines.push(`\nエラー: ${lastError}`);

  const summary = lines.join("\n");
  await finalizeGeneration(statusId, {
    content: successes > 0 ? summary : "",
    reasoning: null,
    usageJson,
    // 1件も取れなかったときは、そのまま再試行できるようエラー扱いにする
    status: successes > 0 ? "done" : "error",
    error: successes > 0 ? null : summary.replace(/\*\*/g, ""),
  });
}
