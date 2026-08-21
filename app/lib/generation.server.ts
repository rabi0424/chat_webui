import {
  fetchPoeRecentPoints,
  fetchPoeRunPoints,
  openRouterChatRequest,
  poeChatRequest,
  POE_PREFIX,
  type ChatMessage,
} from "./openrouter.server";
import { buildGenerationPayload, type ParamsState } from "./params";
import {
  formatRetryProgress,
  RETRY_RATE_LIMIT_ROUNDS,
  type RetryConfig,
} from "./retry";
import {
  appendAssistantMessage,
  createGeneratedAttachment,
  finalizeGeneration,
  flushGeneration,
  getAttachments,
  getMessage,
  rewriteMessageContent,
} from "./db.server";
import {
  ALLOWED_IMAGE_TYPES,
  getFile,
  isStorageConfigured,
  putFile,
  toBase64,
} from "./r2.server";
import type { UiCitation } from "./types";

/**
 * OpenRouterのサーバーツール（beta）。
 *
 * 実行するのはOpenRouter側なので、こちらにツール実行のループは要らない
 * （届くのは今までどおり content と、根拠の annotations だけ）。
 * web_fetch が渡されたURLの本文取得、web_search が検索で、両方渡すと
 * 「URLを読み、必要ならその先のリンクを自分で辿る」動きが成立する。
 *
 * tool calling に対応したモデルでしか使えないため、非対応のモデルでは
 * 従来どおり :online（検索を1回前置きするプラグイン）へ落とす。
 * 対応可否の判定はモデル一覧の supported_parameters で行い、
 * クライアントが webTools として申告する。
 */
const WEB_SERVER_TOOLS = [
  { type: "openrouter:web_fetch" },
  { type: "openrouter:web_search" },
];

/**
 * 1応答あたりに保存する参照元の上限。
 * リンクを辿るほど増えるので、表示が本文を押しのけない程度で止める。
 */
const MAX_CITATIONS = 30;

/**
 * サーバー側生成のジョブ実行。
 *
 * Durable Object のアラームハンドラ内から呼ばれ、上流（OpenRouter）の
 * SSEを読みながら一定間隔でD1へ部分保存し、終了時に確定させる。
 * クライアントへの直接中継は行わず、すべての画面がD1のポーリングで
 * 生成過程を閲覧する（イベントとして完了まで実行が保証される）。
 */

/**
 * D1へ部分保存する間隔。ここがそのまま「本文が届く粒度」になる。
 * 短くすると表示は細かくなるが、そのぶんD1への書き込みと
 * クライアントのポーリング取得が増える（生成1回あたり数十回 → 百数十回）。
 * 表示の滑らかさは受け取ったあとの見せ方（StreamingMessage）で作るので、
 * ここは体感が変わる範囲で控えめに詰めている。
 */
const FLUSH_INTERVAL_MS = 500;

/**
 * 長い応答での部分保存の間隔と、そこへ切り替えるまでの回数。
 *
 * D1への保存もサブリクエストとして数えられ、1回の実行あたりの上限
 * （無料プランでは内部サービスへ1,000件）を超えると以降の保存が
 * 失敗する。長考モデルの応答は数分続くことがあるので、序盤だけ細かく
 * 保存し、あとは粗くして上限に届かないようにする。読み手にとっては
 * 序盤ほど「動いている」ことが分かればよく、粒度の粗さは
 * StreamingMessage 側の見せ方が吸収する。
 */
const LONG_FLUSH_INTERVAL_MS = 2_000;
const SMOOTH_FLUSHES = 300;

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
/**
 * ストリームが無音のまま経過してよい時間。
 * 上流が接続だけ維持して何も送らないと read() は永久に返らないため、
 * ここで打ち切ってその時点の内容で確定させる。
 */
const UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

const MAX_CAPTURED_IMAGES = 8;
const MAX_CAPTURED_BYTES = 20 * 1024 * 1024;

/**
 * 1回の実行（＝DOのアラーム1回）で発行してよい外部リクエストの本数。
 *
 * Workers は1回の呼び出しで出せるサブリクエストの数に上限があり、
 * 無料プランでは外部への fetch が50件。使い切ると以降の fetch が
 * その場で失敗し、利用者には「上流への接続に失敗しました」と見える。
 * 「成功するまで生成」は1回の依頼で何十本も投げるモードなので、
 * 上限に届く前に切り上げて続きを次のアラームへ送る（アラームは
 * 呼び出しが別なので、そのたびに枠が戻る）。
 */
const CHUNK_EXTERNAL_LIMIT = 44;
/**
 * 新しい試行を始めてよいのはここまで。残りは生成画像の取り込みに使う
 * （Poeは本文にCDNのURLを返すため、1枚につき1件の外部取得が要る）。
 */
const CHUNK_LAUNCH_LIMIT = 30;
/**
 * 見出しの打ち直しに使ってよい回数（D1への書き込み）。
 *
 * 内部サービスへのサブリクエストは無料プランで1回の呼び出しにつき
 * 1,000件。見出しは毎秒打ち直すので、実行が長引くとここが先に尽きる。
 * 成功の保存や画像の取り込みで使う分（発射の上限から見て多くても
 * 150件ほど）と、切り上げ後に走っている分を受け取り切るまでの分を
 * 残すため、打ち直しはこの回数で頭打ちにして次のアラームへ送る。
 */
const CHUNK_TOUCH_LIMIT = 500;

/** この実行で使ったサブリクエストの本数を数える。 */
interface ExternalBudget {
  /** 外部リクエストを1件使う。 */
  spend(): void;
  /** ここまでに使った外部リクエストの本数。 */
  spent(): number;
  /** 見出しの打ち直しを1回使う。 */
  spendTouch(): void;
  /** ここまでに打ち直した回数。 */
  touched(): number;
  /** あと1件、外部リクエストを使える枠があるか。 */
  available(): boolean;
  /** 新しい試行を始めてよいか。 */
  canLaunch(): boolean;
}

function createBudget(): ExternalBudget {
  let spent = 0;
  let touched = 0;
  return {
    spend: () => {
      spent++;
    },
    spent: () => spent,
    spendTouch: () => {
      touched++;
    },
    touched: () => touched,
    available: () => spent < CHUNK_EXTERNAL_LIMIT,
    canLaunch: () => spent < CHUNK_LAUNCH_LIMIT && touched < CHUNK_TOUCH_LIMIT,
  };
}

/**
 * 上流が申告するレート制限。
 *
 * Poe は1分あたりの上限と、残り・枠が戻るまでの時間をヘッダで返す
 * （x-ratelimit-limit-requests / -remaining-requests / -reset-requests）。
 * 429 のときは Retry-After も見る。これらがあれば「決め打ちの秒数」では
 * なく上流が言った通りに待てるので、待ちすぎも待たなすぎも避けられる。
 * ヘッダを返さない上流もあるため、無ければ従来の固定バックオフに落ちる。
 */
const RATE_LIMIT_MAX_WAIT_MS = 60_000;
/** 残りがこれ以下になったら、枠が戻るまで新しい発射を控える。 */
const RATE_LIMIT_MIN_REMAINING = 2;

/**
 * "3" / "1.5s" / "500ms" / "1m30s" のいずれもミリ秒にする。
 * 単位なしの数値は秒（Retry-After の形式）とみなす。
 */
function parseDurationMs(value: string | null): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const parts = text.match(/\d+(?:\.\d+)?(?:ms|s|m|h)/g);
  if (!parts) return null;
  const unitMs: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  for (const part of parts) {
    const unit = part.replace(/^[\d.]+/, "");
    total += Number(part.slice(0, part.length - unit.length)) * unitMs[unit];
  }
  return total;
}

interface RateLimitGate {
  /** 応答のヘッダを見る。残りが尽きかけていたら発射を控える。 */
  note(res: Response): void;
  /** 429 応答から、待つべき時間を読む。分からなければ null。 */
  waitAfter(res: Response): number | null;
  /** この時刻まで新しい発射を控える。 */
  until(): number;
}

function createRateLimitGate(): RateLimitGate {
  let until = 0;
  const resetMs = (res: Response) =>
    parseDurationMs(res.headers.get("x-ratelimit-reset-requests"));
  return {
    note(res) {
      const remaining = Number(
        res.headers.get("x-ratelimit-remaining-requests"),
      );
      if (!Number.isFinite(remaining) || remaining > RATE_LIMIT_MIN_REMAINING) {
        return;
      }
      // 枠が戻る時刻を上流が言っていなければ、ひと呼吸だけ置く
      const wait = Math.min(resetMs(res) ?? 1000, RATE_LIMIT_MAX_WAIT_MS);
      until = Math.max(until, Date.now() + wait);
    },
    waitAfter(res) {
      const wait = parseDurationMs(res.headers.get("retry-after")) ?? resetMs(res);
      if (wait == null) return null;
      return Math.min(Math.max(wait, 500), RATE_LIMIT_MAX_WAIT_MS);
    },
    until: () => until,
  };
}

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

/**
 * そのURLが画像記法 `![...](url)` の中に書かれているか。
 *
 * URLだけを返すボットがあり（extractImageUrls は裸のURLも拾う）、
 * その場合に自前の配信URLへ素で差し替えると、本文がただのパス文字列に
 * なって画像として出なくなる。包み直すかどうかの判断に使う。
 */
function isMarkdownImage(content: string, url: string): boolean {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`!\\[[^\\]]*\\]\\(\\s*<?${escaped}`).test(content);
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
  budget: ExternalBudget,
): Promise<string | null> {
  try {
    let payload: { buffer: ArrayBuffer; mimeType: string } | null = null;
    if (url.startsWith("data:")) {
      payload = decodeDataUrl(url);
    } else {
      budget.spend();
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
 *
 * 外部リクエストの枠が尽きたときは deferred を立てて途中で切り上げる。
 * 未取り込みのURLは必ず本文に残す（上流の images フィールドで来たものは
 * 本文へ書き足す）ので、次の実行で本文を読み直せば取り込みを続けられる。
 * ここで諦めてURLを捨てると、Poeのように期限付きCDNを返す上流では
 * あとから画像が消えてしまう。
 */
async function captureGeneratedImages(
  content: string,
  imageUrls: string[],
  target: { messageId: string; conversationId: string; prompt: string | null },
  budget: ExternalBudget,
): Promise<{ content: string; deferred: boolean }> {
  if (!isStorageConfigured()) return { content, deferred: false };

  let out = content;
  let deferred = false;
  /** data: URL は取得が要らないので枠を消費しない。 */
  const needsFetch = (url: string) => !url.startsWith("data:");

  for (const url of extractImageUrls(content)) {
    if (needsFetch(url) && !budget.available()) {
      deferred = true;
      break;
    }
    const id = await storeImage(url, target, budget);
    if (!id) continue;
    const served = `/api/files/${id}`;
    // 画像記法で書かれていないURLは、差し替えるときに記法を足す。
    // 素で置き換えると本文が `/api/files/…` というテキストだけになる
    out = isMarkdownImage(out, url)
      ? out.split(url).join(served)
      : out.split(url).join(`![生成画像](${served})`);
  }
  for (const url of imageUrls.slice(0, MAX_CAPTURED_IMAGES)) {
    if (needsFetch(url) && !budget.available()) {
      // 本文に無いURLなので、持ち越すために本文へ書き足しておく
      out += `${out ? "\n\n" : ""}![生成画像](${url})`;
      deferred = true;
      continue;
    }
    const id = await storeImage(url, target, budget);
    if (id) out += `${out ? "\n\n" : ""}![生成画像](/api/files/${id})`;
  }
  return { content: out, deferred };
}

export interface GenerationJob {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  web: boolean;
  /**
   * Webをサーバーツールとして渡すか（OpenRouterのみ）。
   * false でも web が立っていれば :online へ落とす。ジョブは
   * デプロイをまたいで残りうるので、未指定は従来動作とみなす。
   */
  webTools?: boolean;
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

  // Webの扱いはOpenRouter専用。Poeは素のモデル名で投げる
  if (isPoe) {
    return await poeChatRequest({
      model: modelName,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...buildGenerationPayload(job.paramsState, "poe"),
    });
  }

  const send = (tools: boolean) =>
    openRouterChatRequest({
      // 検索プラグインはモデル名の接尾辞で指定する。サーバーツールを
      // 渡すときは付けない（同じ検索を二重に走らせないため）
      model: !tools && job.web ? `${modelName}:online` : modelName,
      messages: applyPromptCaching(job.model, messages),
      stream: true,
      usage: { include: true },
      // 画像を出せるモデルでも、明示しないとテキストしか返らない
      ...(job.imageOutput ? { modalities: ["image", "text"] } : {}),
      ...(tools ? { tools: WEB_SERVER_TOOLS } : {}),
      ...buildGenerationPayload(job.paramsState, "openrouter"),
    });

  if (!job.web || !job.webTools) return await send(false);

  const res = await send(true);
  // サーバーツールはbetaで、指定の形は変わりうる。弾かれたときに応答ごと
  // 失わせず、検索プラグインの側へ下がってもう一度だけ投げる。
  // 400の原因が⚙のパラメータ側なら、ツール抜きでも同じエラーが返るので
  // 利用者に見せる文言は変わらない（外部リクエストを1件余計に使うのは、
  // このやり直しの経路だけ）。
  if (res.status !== 400) return res;
  try {
    await res.body?.cancel();
  } catch {
    // 既に閉じている場合は無視
  }
  return await send(false);
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
  // レート制限は「いつ投げ直せるか」が分かれば十分なので、上流が
  // 申告している枠の戻り時刻をそのまま伝える
  if (upstream.status === 429) {
    const wait =
      parseDurationMs(upstream.headers.get("retry-after")) ??
      parseDurationMs(upstream.headers.get("x-ratelimit-reset-requests"));
    const when = wait == null ? "" : `約${Math.ceil(wait / 1000)}秒後に`;
    return `レート制限に達しました。${when}投げ直してください。${
      detail ? `\n${detail}` : ""
    }`;
  }
  return (
    (detail || `${isPoe ? "Poe" : "OpenRouter"} APIエラー (${upstream.status})`) +
    hint
  );
}

/**
 * annotations から参照元を拾う。
 *
 * 実物: {"type":"url_citation",
 *        "url_citation":{"url":"https://…","title":"…",
 *                        "start_index":100,"end_index":200}}
 * title が欠けて届くことがあるので、URLだけを必須にする。
 * 同じページを何度も引くことがあるためURLで重複を落とす。
 */
function collectCitations(v: unknown, out: UiCitation[]): void {
  if (!Array.isArray(v)) return;
  for (const item of v) {
    const cite = (item as { url_citation?: Record<string, unknown> } | null)
      ?.url_citation;
    const url = typeof cite?.url === "string" ? cite.url : "";
    if (!url || out.some((c) => c.url === url)) continue;
    if (out.length >= MAX_CITATIONS) return;
    const title = typeof cite?.title === "string" ? cite.title : "";
    out.push(title ? { url, title } : { url });
  }
}

interface StreamResult {
  content: string;
  reasoning: string;
  usageJson: string | null;
  /** images フィールドで返ってきた生成画像（多くは data: URL）。 */
  imageUrls: string[];
  /** Webツールを使った応答の参照元（使わなければ空）。 */
  citations: UiCitation[];
  finishReason?: string;
  /** 停止要求で打ち切ったか。 */
  stopped: boolean;
  /**
   * 上流が最後まで送らずに終わったか（切断・読み取りエラー）。
   *
   * 握りつぶすと、途中で切れた応答が完結したものと見分けられないまま
   * 確定してしまう。リトライ生成では「拒否」や「成功」として誤って
   * 数えられるので、呼び出し側が区別できるように持ち帰る。
   */
  interrupted?: string;
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
  /**
   * 上流が1バイトも送ってこないまま経過してよい時間。
   *
   * 応答が始まったあとに黙り込む上流もあり、その場合 read() は永久に
   * 返らない。読むたびに時計を張り直し、超えたら打ち切って
   * ここまでの内容で確定させる（実行が固まったままにならないように）。
   */
  const readOnce = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("上流からの応答が途絶えました")),
        UPSTREAM_IDLE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([reader.read(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usageJson: string | null = null;
  let finishReason: string | undefined;
  let interrupted: string | undefined;
  const imageUrls: string[] = [];
  const citations: UiCitation[] = [];
  let stopped = false;
  let lastProgress = Date.now();
  let flushes = 0;

  try {
    for (;;) {
      const { done, value } = await readOnce();
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
                annotations?: unknown;
              };
              message?: { images?: unknown; annotations?: unknown };
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
          // 参照元も同じく、delta と message の両方に載りうる
          collectCitations(choice?.delta?.annotations, citations);
          collectCitations(choice?.message?.annotations, citations);
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

      const interval =
        flushes < SMOOTH_FLUSHES ? FLUSH_INTERVAL_MS : LONG_FLUSH_INTERVAL_MS;
      if (onProgress && Date.now() - lastProgress >= interval) {
        lastProgress = Date.now();
        flushes++;
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
  } catch (e) {
    // 上流の切断・エラー: ここまでの内容で確定するが、途中で切れたことは
    // 呼び出し側へ伝える（停止操作による打ち切りは正常な終わり方なので除く）
    if (!stopped) interrupted = (e as Error).message || "接続が途中で切れました";
    // 無音で打ち切った場合、読み手はまだ待っている。掴んだままにしない
    try {
      await reader.cancel();
    } catch {
      // 既に閉じていれば何もしない
    }
  }

  // 終端後に残ったぶんを取りこぼさない。改行で終わらないストリームでは
  // 最後の1行が buffer に、マルチバイト文字の断片が decoder に残る
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const payload = tail.slice(5).trim();
    if (payload && payload !== "[DONE]") {
      try {
        const chunk = JSON.parse(payload) as {
          choices?: {
            delta?: { content?: string | null };
            finish_reason?: string | null;
          }[];
        };
        const choice = chunk.choices?.[0];
        if (typeof choice?.delta?.content === "string") {
          content += choice.delta.content;
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      } catch {
        // 途中で切れた不完全なJSONは捨てる
      }
    }
  }

  return {
    content,
    reasoning,
    usageJson,
    imageUrls,
    citations,
    finishReason,
    stopped,
    interrupted,
  };
}

/**
 * 例外を投げず、必ずメッセージ行を確定させて終了する。
 *
 * リトライ生成は1回の呼び出しで終わらないことがある（外部リクエストの
 * 上限に届く前に切り上げるため）。done: false のときは state を保存して
 * もう一度呼ぶこと。state は前回の戻り値をそのまま渡す。
 */
export async function runGenerationJob(
  job: GenerationJob,
  state: RetryRunState | null = null,
): Promise<JobOutcome> {
  if (job.retry) return await runRetryGenerationJob(job, job.retry, state);
  await runSingleGeneration(job);
  return { done: true };
}

async function runSingleGeneration(job: GenerationJob): Promise<void> {
  const startedAt = Date.now();
  const isPoe = job.model.startsWith(POE_PREFIX);
  const modelName = isPoe ? job.model.slice(POE_PREFIX.length) : job.model;
  // 1応答ぶんなので枠には十分収まるが、取り込む画像の枚数だけは
  // 上流しだいなので、リトライ生成と同じ数え方で歯止めをかけておく
  const budget = createBudget();

  let upstream: Response;
  try {
    budget.spend();
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

  /**
   * 上流が無言のあいだも「生きている」印を打ち直す。
   *
   * 部分保存は上流からチャンクが届いたときにしか走らないため、最初の
   * トークンまで時間のかかるモデル（長考・画像生成）では flushed_at が
   * 更新されないまま sweepStaleStreaming の中断判定（60秒）に掛かる。
   * そうなると生成はまだ走っているのに行だけ確定してしまい、停止も効かず、
   * 完了時の確定（status='streaming' 条件）も空振りして結果が失われる。
   */
  let latest = { content: "", reasoning: null as string | null };
  let lastWrite = Date.now();
  let streamDone = false;
  let wakeHeartbeat = () => {};

  const write = async (): Promise<boolean> => {
    lastWrite = Date.now();
    const { stopRequested } = await flushGeneration(job.assistantMessageId, {
      content: latest.content,
      reasoning: latest.reasoning,
    });
    return stopRequested;
  };

  const heartbeat = (async () => {
    while (!streamDone && Date.now() - startedAt < MAX_HEARTBEAT_MS) {
      const nap = cancellableSleep(IDLE_HEARTBEAT_MS);
      wakeHeartbeat = nap.cancel;
      await nap.promise;
      // 直前にチャンクが届いて保存済みなら、打ち直す必要はない
      if (streamDone || Date.now() - lastWrite < IDLE_HEARTBEAT_MS) continue;
      try {
        await write();
      } catch {
        // 打ち直しの失敗そのものは致命的ではない。次の周期で拾う
      }
    }
  })();

  const result = await readUpstreamStream(upstream.body, async (partial) => {
    latest = { content: partial.content, reasoning: partial.reasoning || null };
    return await write();
  });
  streamDone = true;
  wakeHeartbeat();
  await heartbeat;
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
      : (
          await captureGeneratedImages(
            result.content,
            result.imageUrls,
            {
              messageId: job.assistantMessageId,
              conversationId: job.conversationId,
              prompt: promptOf(job),
            },
            budget,
          )
        ).content;
  // 画像だけの応答（本文なし）も成功として扱う
  const empty = finalContent === "";

  await finalizeGeneration(job.assistantMessageId, {
    // 途中で切れた応答は、完結したものと見分けが付かないまま残すと
    // 利用者がそのまま次の話へ進んでしまう。本文に注記を足しておく
    content:
      !empty && result.interrupted
        ? `${finalContent}\n\n---\n\n※ 応答が途中で終わりました（${result.interrupted}）。もう一度生成すると続きが得られることがあります。`
        : finalContent,
    reasoning: result.reasoning || null,
    usageJson,
    citationsJson:
      result.citations.length > 0 ? JSON.stringify(result.citations) : null,
    status: empty ? "error" : "done",
    error: empty
      ? result.stopped
        ? "生成開始直後に停止されました"
        : result.interrupted
          ? `応答を受け取る前に接続が切れました（${result.interrupted}）`
          : `モデルから本文のない応答が返りました${
              result.finishReason ? `（finish_reason: ${result.finishReason}）` : ""
            }`
      : null,
  });
}

// --- 成功するまで生成する（リトライ生成） ---------------------------------

/**
 * 見出しメッセージの打ち直し間隔。
 *
 * 進捗の表示であると同時に、中断（放置）とみなされる前に打つ生存確認、
 * そして**停止要求を拾う経路**でもある。ここを短くするほど停止が速く
 * 効き、実行中の本数も細かく見えるが、そのぶんD1への書き込みが増える。
 * 打ち直しの総回数は CHUNK_TOUCH_LIMIT で頭打ちにしてある。
 */
const HEARTBEAT_MS = 1_000;

/**
 * 単発生成で「まだ生きている」印を打ち直す間隔。
 * 中断とみなされるまでの猶予（db.server.ts の STALE_STREAMING_MS = 60秒）に
 * 対して十分に短く、かつD1への書き込みが増えすぎない程度に空ける。
 */
const IDLE_HEARTBEAT_MS = 15_000;

/**
 * 打ち直しを続ける上限。
 *
 * 印を打ち続けている限り中断とみなされないので、上流が永久に沈黙した
 * 場合に「生成中」の表示が二度と解けなくなる。ここで打ち直しをやめれば
 * 60秒後には中断として確定し、UIが固まったままにならずに済む。
 */
const MAX_HEARTBEAT_MS = 30 * 60 * 1000;

/**
 * 続けて発射するときに挟む間隔。
 *
 * 並列数ぶんを一度に投げると上流へ同時に当たる。生成自体は数十秒
 * かかるので、ここで少しずらしても体感は変わらない。
 */
const LAUNCH_STAGGER_MS = 200;
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
  /** waitMs は上流が申告した待ち時間。無ければ null（固定の待ちに落ちる）。 */
  | { kind: "rate_limited"; waitMs: number | null }
  | { kind: "error"; error: string };

/**
 * 1回分の生成。成功の判定は「画像が1枚以上あるか」だけで、
 * 拒否文の文言は見ない（言語や表現に依存して壊れるため）。
 */
async function runAttempt(
  job: GenerationJob,
  messages: OutgoingMessage[],
  budget: ExternalBudget,
  gate: RateLimitGate,
): Promise<AttemptOutcome> {
  const isPoe = job.model.startsWith(POE_PREFIX);
  let upstream: Response;
  try {
    budget.spend();
    upstream = await requestUpstream(job, messages);
  } catch (e) {
    return {
      kind: "error",
      error: `${isPoe ? "Poe" : "OpenRouter"}への接続に失敗しました: ${(e as Error).message}`,
    };
  }

  gate.note(upstream);

  if (upstream.status === 429) {
    const waitMs = gate.waitAfter(upstream);
    try {
      await upstream.body?.cancel();
    } catch {
      // 読み捨てるだけ
    }
    return { kind: "rate_limited", waitMs };
  }
  if (!upstream.ok || !upstream.body) {
    return { kind: "error", error: await upstreamErrorMessage(upstream, isPoe) };
  }

  const result = await readUpstreamStream(upstream.body);
  const hasImage =
    result.imageUrls.length > 0 || extractImageUrls(result.content).length > 0;
  // 画像が揃っているなら、途中で切れていても成果は成果なので受け取る。
  // 揃っていないのに切れた場合は「拒否」ではなく通信の失敗として数える
  // （拒否として数えると、モデルが断ったのか回線が切れたのか分からなくなる）
  if (!hasImage && result.interrupted) {
    return {
      kind: "error",
      error: `応答が途中で切れました: ${result.interrupted}`,
    };
  }
  return hasImage
    ? {
        kind: "success",
        content: result.content,
        usageJson: result.usageJson,
        imageUrls: result.imageUrls,
      }
    : { kind: "refused", text: result.content };
}

/**
 * チャンクをまたいで引き継ぐ、リトライ生成の途中経過。
 *
 * 実行中の1本1本はその実行の中でしか生きられない（呼び出しが終わると
 * fetch も終わる）ので、持ち越すのは「どこまで進んだか」だけにする。
 * DOのストレージへそのまま入れるため、小さく保つ（拒否文は要約に出す
 * 1件だけ持ち、残りは件数で数える）。
 */
export interface RetryRunState {
  /** 実行全体の開始時刻。Poeのポイント集計に使う。 */
  startedAt: number;
  attempts: number;
  successes: number;
  rateLimitRounds: number;
  /** 次の成功を繋ぐ先。 */
  parentId: string;
  /**
   * 試行の内訳。successes と合わせた合計が attempts に一致する
   * （どの試行がどう終わったのか、要約から追えるようにするため）。
   *
   * - refusals: 画像は無いが本文は返ってきた応答（拒否文など）
   * - emptyResponses: 画像も本文も無い空の応答
   * - errors: 接続失敗・上流のエラー・結果の取り込み失敗
   */
  refusals: number;
  emptyResponses: number;
  errors: number;
  /** 要約に出す拒否文の最初の1件。 */
  firstRefusal: string | null;
  lastError: string | null;
  /** 画像の取り込みが途中で終わった成功メッセージのID。 */
  pendingCapture: string[];
}

/** ジョブ1回ぶんの実行結果。done でなければ続きが残っている。 */
export type JobOutcome =
  | { done: true }
  | { done: false; state: RetryRunState };

function initialRetryState(statusId: string): RetryRunState {
  return {
    startedAt: Date.now(),
    attempts: 0,
    successes: 0,
    rateLimitRounds: 0,
    parentId: statusId,
    refusals: 0,
    emptyResponses: 0,
    errors: 0,
    firstRefusal: null,
    lastError: null,
    pendingCapture: [],
  };
}

/**
 * 持ち越された途中経過を、いまの形へ揃える。
 *
 * 前の版が保存した state には後から足した数え上げが無い。欠けたまま
 * 加算すると NaN になり、以後の進捗も要約も丸ごと壊れるため補う。
 */
function restoreRetryState(
  previous: RetryRunState | null,
  statusId: string,
): RetryRunState {
  const base = initialRetryState(statusId);
  if (!previous) return base;
  return {
    ...base,
    ...previous,
    refusals: previous.refusals ?? 0,
    emptyResponses: previous.emptyResponses ?? 0,
    errors: previous.errors ?? 0,
  };
}

/**
 * 前の実行で取り込みきれなかった画像を拾い直す。
 *
 * 未取り込みのURLは本文に残してあるので、保存済みの本文をもう一度
 * 取り込みにかければよい。枠がまた尽きたら、そのまま次へ持ち越す。
 */
async function drainPendingCaptures(
  job: GenerationJob,
  state: RetryRunState,
  budget: ExternalBudget,
): Promise<void> {
  if (state.pendingCapture.length === 0) return;
  const remaining: string[] = [];
  for (const messageId of state.pendingCapture) {
    if (!budget.available()) {
      remaining.push(messageId);
      continue;
    }
    const row = await getMessage(job.conversationId, messageId);
    if (!row) continue;
    const captured = await captureGeneratedImages(
      row.content,
      [],
      {
        messageId,
        conversationId: job.conversationId,
        prompt: promptOf(job),
      },
      budget,
    );
    if (captured.content !== row.content) {
      await rewriteMessageContent(messageId, captured.content);
    }
    if (captured.deferred) remaining.push(messageId);
  }
  state.pendingCapture = remaining;
}

/**
 * 成功するまで生成するモード。
 *
 * 先頭に見出しのメッセージを1つ置き、その下に成功した応答を直列に
 * 積んでいく（左右の切り替えなしで全部見える）。見出しは実行中は進捗、
 * 終了後は結果の要約と拒否の内訳になる。成功は目標数を超えても捨てない
 * （並列に走っている分は既に課金されているため）。
 *
 * 1回の呼び出しで出せる外部リクエストには上限があるため、この関数は
 * 実行全体ではなく**1チャンクぶん**を進めて返す。枠を使い切っても
 * まだ続きがあるなら done: false を返し、呼び出し元（DOのアラーム）が
 * 途中経過を保存して次のアラームで続きを走らせる。
 */
async function runRetryGenerationJob(
  job: GenerationJob,
  retry: RetryConfig,
  previous: RetryRunState | null,
): Promise<JobOutcome> {
  const isPoe = job.model.startsWith(POE_PREFIX);
  const modelName = isPoe ? job.model.slice(POE_PREFIX.length) : job.model;
  const statusId = job.assistantMessageId;
  const budget = createBudget();
  const state = restoreRetryState(previous, statusId);

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
    return { done: true };
  }

  let stopped = false;
  /** レート制限に当たったら、この時刻まで新しい発射を控える。 */
  let pauseUntil = 0;
  let rateLimitExhausted = false;
  const inflight = new Set<Promise<void>>();
  const gate = createRateLimitGate();
  /** 自分で決めた待ちと、上流が申告した待ちの遅いほう。 */
  const waitUntil = () => Math.max(pauseUntil, gate.until());

  /** 進捗の保存を兼ねた停止確認。 */
  const touch = async (): Promise<boolean> => {
    budget.spendTouch();
    const { stopRequested } = await flushGeneration(statusId, {
      content: formatRetryProgress({
        successes: state.successes,
        attempts: state.attempts,
        inflight: inflight.size,
        retry,
      }),
      reasoning: null,
    });
    if (stopRequested) stopped = true;
    return stopRequested;
  };

  // 前の実行が取り込みきれなかった画像を先に拾う（枠を使うので発射より先）
  await drainPendingCaptures(job, state, budget);

  /**
   * 結果の取り込みは1件ずつ直列に行う。
   * 成功は前の成功の下に繋ぐので、同時に走らせると親が競合する。
   */
  let queue: Promise<void> = Promise.resolve();
  const accept = (r: AttemptOutcome): Promise<void> => {
    // 1件の取り込みが失敗しても、キュー自体は必ず成功で繋ぐ。
    // ここで握らないとキューが reject のまま固まり、以降に届いた
    // 成功応答の取り込みが丸ごと飛ばされる（課金済みの結果が消える）
    queue = queue.then(() => acceptOne(r)).catch(() => {});
    return queue;
  };

  const acceptOne = async (r: AttemptOutcome): Promise<void> => {
    let counted = false;
    try {
      if (r.kind === "rate_limited") {
        // レート制限は上流の都合なので試行回数は消費しない。
        // ただし待ち直しの回数には上限を設ける
        if (state.rateLimitRounds >= RETRY_RATE_LIMIT_ROUNDS) {
          state.lastError = "レート制限が続いたため打ち切りました";
          rateLimitExhausted = true;
          return;
        }
        // 上流が待ち時間を言っていればそれに従う（決め打ちより正確で、
        // 待ちすぎも待たなすぎも避けられる）。無ければ従来のバックオフ
        pauseUntil =
          Date.now() +
          (r.waitMs ??
            RATE_LIMIT_BACKOFF_MS[
              Math.min(state.rateLimitRounds, RATE_LIMIT_BACKOFF_MS.length - 1)
            ]);
        state.rateLimitRounds++;
        return;
      }

      // 試行に数えた以上、必ずどれか1つの内訳にも数える
      // （数え漏れると要約の内訳が試行回数と合わなくなる）。
      // 取り込みの途中で失敗した分は catch 側で拾う
      state.attempts++;
      if (r.kind === "error") {
        state.errors++;
        counted = true;
        state.lastError = r.error;
      } else if (r.kind === "refused") {
        // 画像が無い応答。本文があるかで分ける（空の応答は上流の
        // 揺らぎで、拒否文が返るのとは原因も対処も違う）
        if (r.text.trim()) {
          state.refusals++;
          state.firstRefusal ??= r.text.trim().slice(0, 301);
        } else {
          state.emptyResponses++;
        }
        counted = true;
      } else {
        // 成功: 応答を1件足し、画像を自前のストレージへ移す。
        // 待たずにここで保存するので、実行中でも順に見えるようになる
        const id = await appendAssistantMessage({
          conversationId: job.conversationId,
          parentId: state.parentId,
          modelId: job.model,
          content: r.content,
          usageJson: r.usageJson,
        });
        const captured = await captureGeneratedImages(
          r.content,
          r.imageUrls,
          {
            messageId: id,
            conversationId: job.conversationId,
            prompt: promptOf(job),
          },
          budget,
        );
        if (captured.content !== r.content) {
          await rewriteMessageContent(id, captured.content);
        }
        // 枠が尽きて取り込めなかったぶんは次の実行で拾う
        if (captured.deferred) state.pendingCapture.push(id);
        state.parentId = id;
        state.successes++;
        counted = true;
      }
      await touch();
    } catch (e) {
      // D1の一時障害などで1件取り込めなかった場合。実行は続け、
      // 見出しの要約に理由を残す。まだどの内訳にも数えていなければ
      // ここでエラーとして数える（合計が試行回数からずれないように）
      if (!counted) state.errors++;
      state.lastError = `結果の取り込みに失敗しました: ${(e as Error).message}`;
    }
  };

  const launch = () => {
    const p = runAttempt(job, messages, budget, gate)
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
    if (Date.now() < waitUntil()) {
      await sleep(waitUntil() - Date.now());
      continue;
    }
    // 目標に届くまで、上限と並列数の範囲で発射し続ける
    let burst = 0;
    while (
      !stopped &&
      state.successes < retry.target &&
      state.attempts + inflight.size < retry.maxAttempts &&
      inflight.size < retry.concurrency &&
      Date.now() >= waitUntil() &&
      // 外部リクエストの枠を使い切る手前で切り上げ、続きは次の実行へ
      budget.canLaunch()
    ) {
      // 並列数ぶんを一度に投げると上流へ同時に当たる。2本目以降はずらす。
      // ずらしの待ちは停止確認より**前**に置く。待っている間に停止要求が
      // 届くことがあり、確認が先だとその1本を止められない
      if (burst > 0) await sleep(LAUNCH_STAGGER_MS);
      // 停止要求は発射の直前に見る。発射してから気づいたのでは、
      // 押したあとに1本ぶん余計に投げて課金されてしまう
      if (await touch()) break;
      launch();
      burst++;
    }
    // 発射した分を見出しへ反映する（上の touch は発射前の状態のため）
    if (burst > 0) await touch();
    if (inflight.size === 0) break;
    await Promise.race(inflight);
  }

  // 走っている分は最後まで受け取る（課金済みなので成功は捨てない）
  await Promise.all(inflight);
  await queue;
  finished = true;
  wakeHeartbeat();
  await heartbeat;

  /**
   * まだ投げるべき試行が残っているか。停止・打ち切り・目標到達・
   * 上限到達のいずれでもなければ、枠切れで中断しただけなので続ける。
   */
  const moreAttempts =
    !stopped &&
    !rateLimitExhausted &&
    state.successes < retry.target &&
    state.attempts < retry.maxAttempts;
  if (moreAttempts || state.pendingCapture.length > 0) {
    await touch();
    // 枠の使い方を追えるように残す。wrangler tail かダッシュボードのログで見る
    console.log(
      `[gen] retry chunk paused: external=${budget.spent()}/${CHUNK_EXTERNAL_LIMIT} touch=${budget.touched()}/${CHUNK_TOUCH_LIMIT} attempts=${state.attempts} successes=${state.successes} pendingCapture=${state.pendingCapture.length}`,
    );
    return { done: false, state };
  }

  // Poe: 消費ポイントは応答に載らないので、実行時間帯の履歴を合計する
  let usageJson: string | null = null;
  if (isPoe && state.attempts > 0 && budget.available()) {
    await sleep(1500);
    budget.spend();
    const total = await fetchPoeRunPoints(modelName, state.startedAt);
    if (total) {
      usageJson = JSON.stringify({ points: total.points, cost: total.costUsd });
    }
  }

  const lines: string[] = [];
  lines.push(
    stopped
      ? `**停止しました** — 成功 ${state.successes}件・試行 ${state.attempts}回`
      : `**完了** — 成功 ${state.successes}件（目標 ${retry.target}件）・試行 ${state.attempts}回（上限 ${retry.maxAttempts}回）`,
  );
  if (state.successes > retry.target) {
    lines.push(
      `目標より ${state.successes - retry.target}件多く受け取りました（並列で走っていた分です）。`,
    );
  }
  if (!stopped && state.successes < retry.target) {
    lines.push(
      `目標に届きませんでした（上限${state.attempts >= retry.maxAttempts ? "の試行回数" : ""}に達しました）。`,
    );
  }
  // 試行の内訳。成功と合わせた合計が試行回数に一致する
  const breakdown: string[] = [];
  if (state.refusals > 0) {
    breakdown.push(`画像が返らなかった応答 ${state.refusals}回`);
  }
  if (state.emptyResponses > 0) {
    breakdown.push(`空の応答 ${state.emptyResponses}回`);
  }
  if (state.errors > 0) breakdown.push(`エラー ${state.errors}回`);
  if (breakdown.length > 0) lines.push(`\n内訳: ${breakdown.join("・")}`);

  if (state.firstRefusal) {
    lines.push(
      `\n> ${state.firstRefusal.slice(0, 300).replace(/\n+/g, " ")}${
        state.firstRefusal.length > 300 ? "…" : ""
      }`,
    );
  }
  // 待ち直しは試行を消費しないので、内訳とは別に出す。
  // 出しておかないと「時間だけ経って試行が進まない」ように見える
  if (state.rateLimitRounds > 0) {
    lines.push(
      `\nレート制限による待ち直し: ${state.rateLimitRounds}回（試行には数えません）`,
    );
  }
  if (state.lastError) lines.push(`\n最後のエラー: ${state.lastError}`);

  console.log(
    `[gen] retry run finished: external=${budget.spent()}/${CHUNK_EXTERNAL_LIMIT} touch=${budget.touched()}/${CHUNK_TOUCH_LIMIT} attempts=${state.attempts} successes=${state.successes} refusals=${state.refusals} empty=${state.emptyResponses} errors=${state.errors} rateLimited=${state.rateLimitRounds}`,
  );

  const summary = lines.join("\n");
  await finalizeGeneration(statusId, {
    content: state.successes > 0 ? summary : "",
    reasoning: null,
    usageJson,
    kind: "retry",
    // 1件も取れなかったときは、そのまま再試行できるようエラー扱いにする
    status: state.successes > 0 ? "done" : "error",
    error: state.successes > 0 ? null : summary.replace(/\*\*/g, ""),
  });
  return { done: true };
}
