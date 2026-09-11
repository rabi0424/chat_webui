import {
  fetchPoeRecentPoints,
  openRouterChatRequest,
  poeChatRequest,
  type ChatMessage,
} from "./openrouter.server";
import { apiyiChatRequest, applyApiyiCost } from "./apiyi.server";
import {
  PROVIDER_LABELS,
  bareModelName,
  providerOf,
  type ModelProvider,
} from "./constants";
import { buildGenerationPayload, type ParamsState } from "./params";
import { RETRY_ATTEMPT_DEADLINE_MS, type RetryConfig } from "./retry";
import { classifyUpstreamFailure } from "./upstream-outcome";
import { isFetchableImageUrl, looksLikeImageUrl } from "./image-url";
import { sniffImageFormat } from "./image-signature";
import { readBounded } from "./read-bounded";
import { flushInterval } from "./flush-cadence";
import {
  createGeneratedAttachment,
  finalizeGeneration,
  flushGeneration,
  getAttachments,
  recordStandaloneUsage,
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


/** OpenAI互換のマルチモーダルコンテンツ要素。 */
type ContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | {
      type: "image_url";
      image_url: { url: string };
      cache_control?: { type: "ephemeral" };
    };

export interface OutgoingMessage {
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
export async function expandAttachments(
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
export function promptOf(job: GenerationJob): string | null {
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
 * 生成画像の取り込みで、自分で辿るリダイレクトの回数。
 *
 * 上流のCDNは1回ほど噛ませてくるので0では足りない。一方で辿るたびに
 * 外部リクエストの枠を1件使うので、深追いはしない。
 */
const MAX_IMAGE_REDIRECTS = 3;

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
export interface ExternalBudget {
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

export function createBudget(): ExternalBudget {
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

export function createRateLimitGate(): RateLimitGate {
  let until = 0;
  const resetMs = (res: Response) =>
    parseDurationMs(res.headers.get("x-ratelimit-reset-requests"));
  return {
    note(res) {
      // ヘッダが無いときの get() は null で、Number(null) は 0 になる。
      // 「残り0」と読むと、枠の情報を出さない上流では毎回ここで待たされる。
      // 有限かどうかの判定は 0 を通してしまうので、先に null を弾く。
      const header = res.headers.get("x-ratelimit-remaining-requests");
      if (header === null) return;
      const remaining = Number(header);
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
    if (looksLikeImageUrl(m[0])) add(m[0]);
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

/**
 * 生成画像を取りに行く。リダイレクトは自分で辿る。
 *
 * `fetch` の既定（`redirect: "follow"`）だと、**入口で確かめた行き先の
 * 検査が意味を失う**。宛先を決めるのはモデルの出力なので、外向きの
 * URL を返しておいて `302` で `127.0.0.1` や `169.254.169.254` へ
 * 飛ばせば、そのまま追いかけてしまう。手で辿り、飛び先も毎回同じ
 * 検査に通す。
 *
 * 1ホップごとに外部リクエストを1件使う（サブリクエストの枠に効くので、
 * 辿った回数ぶんきちんと数える）。
 */
async function fetchImageResponse(
  url: string,
  budget: ExternalBudget,
): Promise<Response | null> {
  let target = url;
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    // 取りに行く宛先はモデルが本文に書いたもの。こちらが決めた値では
    // ないので、仕組みと宛先を確かめてから出す
    if (!isFetchableImageUrl(target)) return null;
    budget.spend();
    const res = await fetch(target, { redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    try {
      // 相対の Location も来る
      target = new URL(location, target).toString();
    } catch {
      return null;
    }
  }
  return null; // 辿りすぎ（堂々巡りに付き合わない）
}

/**
 * 画像1枚を実体として取り込む。取り込めなければ null。
 *
 * 返す mimeType は**申告ではなく中身**から決める。上流の申告
 * （Content-Type や data: URL の型）は当てにならないので、先頭バイトを
 * 読んで本当の形式を確かめる。画像でないものは捨てる——ここを通すと、
 * 画像のふりをした別のものが R2 に入り、そのまま配信されることになる。
 *
 * 呼び出し側（storeImage）は null を「取り込めなかった」として扱い、
 * 本文のURLを元のまま残す。
 */
export async function captureImagePayload(
  url: string,
  budget: ExternalBudget,
): Promise<{ buffer: ArrayBuffer; mimeType: string } | null> {
  let payload: { buffer: ArrayBuffer; mimeType: string } | null;
  if (url.startsWith("data:")) {
    payload = decodeDataUrl(url);
  } else {
    const res = await fetchImageResponse(url, budget);
    if (!res || !res.ok) return null;
    const mimeType = (res.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) return null;
    // 申告されている大きさで先に弾く（読む前に分かるなら読まない）
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_CAPTURED_BYTES) {
      return null;
    }
    const buffer = await readBounded(res, MAX_CAPTURED_BYTES);
    if (!buffer) return null;
    payload = { buffer, mimeType };
  }
  if (
    !payload ||
    payload.buffer.byteLength === 0 ||
    payload.buffer.byteLength > MAX_CAPTURED_BYTES
  ) {
    return null;
  }
  const actual = sniffImageFormat(payload.buffer);
  if (!actual) return null;
  return { buffer: payload.buffer, mimeType: actual };
}

/** 画像1枚をR2へ保存し、添付IDを返す。取り込めなければ null。 */
async function storeImage(
  url: string,
  target: { messageId: string; conversationId: string; prompt: string | null },
  budget: ExternalBudget,
): Promise<string | null> {
  try {
    const payload = await captureImagePayload(url, budget);
    if (!payload) return null;

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
export async function captureGeneratedImages(
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
  /**
   * 担当1つが同時に投げる本数の上書き（アプリ設定。0/未指定で自動）。
   * ここが依頼1本あたりの実行体の時間＝無料枠の消費を決める。
   */
  workerConcurrency?: number;
  /**
   * 1日に使ってよい「実行体が起きている時間」（秒。0/未指定で歯止めなし）。
   * 使い切ると翌0時（UTC）までどの生成も始められなくなるので、手前で止める。
   */
  dailyDoSecondsBudget?: number;
  paramsState: ParamsState | null;
  messages: ChatMessage[];
}

/** 例外を投げず、必ずメッセージ行を確定させて終了する。 */
/** 上流へのリクエスト。プロバイダごとの差はここに閉じる。 */
export async function requestUpstream(
  job: GenerationJob,
  messages: OutgoingMessage[],
  /**
   * 外部へ1件投げる直前に呼ばれる。枠を数えるために使う。
   *
   * この関数は**1回の呼び出しで2件投げることがある**（サーバーツールが
   * 弾かれたときのやり直し）。呼ぶ側が「1回 = 1件」で数えていたので、
   * 実際の本数が枠の数えを追い越し、上限の手前で切り上げる仕組みが
   * 効かなくなっていた。投げる場所を1つにまとめて、そこで数える。
   */
  onRequest: () => void = () => {},
  /** ヘッダを待つ時間と、外からの打ち切り。省けば既定。 */
  opts: { connectTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const provider = providerOf(job.model);
  const modelName = bareModelName(job.model);

  // Webの扱いはOpenRouter専用。Poeは素のモデル名で投げる
  if (provider === "poe") {
    onRequest();
    return await poeChatRequest(
      {
        model: modelName,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...buildGenerationPayload(job.paramsState, "poe"),
      },
      opts.connectTimeoutMs,
      opts.signal,
    );
  }

  /*
   * API易は OpenAI 互換の中継。画像を出すモデルは stream に対応せず、
   * SSE ではなく JSON を1つ返す（上流の文書に明記がある）。それでも
   * `stream: true` を付けて投げるのは、対応しているモデルでは流れて
   * きてほしいからで、対応しないモデルでは中継が黙って JSON を返す。
   * 返ってきた形は読み手（readUpstreamResponse）が Content-Type で
   * 見分ける。
   */
  if (provider === "apiyi") {
    onRequest();
    return await apiyiChatRequest(
      {
        model: modelName,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...buildGenerationPayload(job.paramsState, "apiyi"),
      },
      opts.connectTimeoutMs,
      opts.signal,
    );
  }

  const send = (tools: boolean) => {
    onRequest();
    return openRouterChatRequest(
      {
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
      },
      opts.connectTimeoutMs,
      opts.signal,
    );
  };

  if (!job.web || !job.webTools) return await send(false);

  const res = await send(true);
  // サーバーツールはbetaで、指定の形は変わりうる。弾かれたときに応答ごと
  // 失わせず、検索プラグインの側へ下がってもう一度だけ投げる。
  // 400の原因が⚙のパラメータ側なら、ツール抜きでも同じエラーが返るので
  // 利用者に見せる文言は変わらない。ここで1件余計に使うぶんは
  // onRequest で数えられる。
  if (res.status !== 400) return res;
  try {
    await res.body?.cancel();
  } catch {
    // 既に閉じている場合は無視
  }
  return await send(false);
}

/** 上流のエラー応答から、利用者に見せる文言を組み立てる。 */
/**
 * 上流のエラー応答の本文を読む。本文は一度しか読めないので、
 * 文言の組み立てと拒否の判定の両方で使うときはここで読んで渡す。
 *
 * detail は利用者に見せる文言。raw は判定用で、OpenRouter が
 * 挟んでくる元プロバイダの生のエラー（metadata.raw）と code も含める
 * （OpenRouter 側の message が汎用的で、拒否の手がかりが raw にしか
 * 無いことがある）。
 */
async function readUpstreamError(
  upstream: Response,
): Promise<{ detail: string; type: string | null; raw: string }> {
  try {
    const err = (await upstream.json()) as { error?: unknown };
    return describeUpstreamError(err.error);
  } catch {
    // ステータスコードだけで十分
    return { detail: "", type: null, raw: "" };
  }
}

/**
 * エラーオブジェクト（HTTP のエラー本文でも、ストリームの中で届いた
 * ものでも同じ形）から、文言・型・生の中身を取り出す。
 *
 * type は Poe の error.type、OpenRouter の error.metadata.error_type。
 * raw は OpenRouter が包む元プロバイダのエラー（metadata）を丸ごと
 * 文字列にしたもので、判定の補助にだけ使う。
 */
function describeUpstreamError(error: unknown): {
  detail: string;
  type: string | null;
  code: number | null;
  raw: string;
} {
  const e = (error ?? {}) as {
    message?: unknown;
    code?: unknown;
    type?: unknown;
    metadata?: { error_type?: unknown } | null;
  };
  const detail = typeof e.message === "string" ? e.message : "";
  const type =
    typeof e.type === "string"
      ? e.type
      : typeof e.metadata?.error_type === "string"
        ? e.metadata.error_type
        : null;
  const code = Number(e.code);
  let raw: string;
  try {
    raw = JSON.stringify(e.metadata ?? "");
  } catch {
    raw = "";
  }
  return {
    detail,
    type,
    code: Number.isInteger(code) && code > 0 ? code : null,
    raw,
  };
}

async function upstreamErrorMessage(
  upstream: Response,
  provider: ModelProvider,
  body?: { detail: string },
): Promise<string> {
  const detail = (body ?? (await readUpstreamError(upstream))).detail;
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
    (detail ||
      `${PROVIDER_LABELS[provider]} APIエラー (${upstream.status})`) + hint
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
   * 200 のあとに本文の中で届いたエラー。OpenRouter は「ヘッダを返した
   * あとの失敗は状態コードではなく本文の中のエラーとして届く」と明記
   * している。見ないと、拒否も上流の障害もただの「空の応答」に見える。
   */
  error?: { detail: string; type: string | null; code: number | null; raw: string };
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
 * 1回の read() を、無音の見張りと外からの打ち切りの下で行う関数を作る。
 *
 * 上流が1バイトも送ってこないまま経過してよい時間（idleTimeoutMs）を
 * 読むたびに張り直す。応答が始まったあとに黙り込む上流もあり、その場合
 * read() は永久に返らない——実行（DOのアラーム）がそこで固まる。
 *
 * ただし、これだけでは「処理中」のコメント行を送り続ける上流
 * （OpenRouter）を切れない。1バイトでも来れば時計が戻るため。
 * そちらは signal（総時間の締め切り）で切る。
 */
function idleGuardedReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal?: AbortSignal,
): () => Promise<ReadableStreamReadResult<Uint8Array>> {
  const abortReason = () =>
    typeof signal?.reason === "string"
      ? signal.reason
      : ((signal?.reason as Error | undefined)?.message ?? "打ち切りました");
  return async () => {
    if (signal?.aborted) throw new Error(abortReason());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("上流からの応答が途絶えました")),
        idleTimeoutMs,
      );
      onAbort = () => reject(new Error(abortReason()));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([reader.read(), timeout]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * SSEを読み切る。
 *
 * onProgress は一定間隔で呼ばれ、true を返すと（停止要求）読み取りを
 * 打ち切る。リトライ生成では途中経過を保存しないので渡さない。
 *
 * signal で外から打ち切れる（総時間の締め切り、停止後の猶予切れ）。
 * 打ち切りは interrupted に理由を残して、ここまでの内容で返す。
 */
export async function readUpstreamStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (partial: {
    content: string;
    reasoning: string;
  }) => Promise<boolean>,
  opts: { idleTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<StreamResult> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS;
  const signal = opts.signal;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const readOnce = idleGuardedReader(reader, idleTimeoutMs, signal);
  let buffer = "";
  let content = "";
  let reasoning = "";
  let usageJson: string | null = null;
  let finishReason: string | undefined;
  let interrupted: string | undefined;
  let streamError: StreamResult["error"];
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
            error?: unknown;
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
          if (chunk.error && typeof chunk.error === "object") {
            streamError = describeUpstreamError(chunk.error);
          }
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

      if (onProgress && Date.now() - lastProgress >= flushInterval(flushes)) {
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
    error: streamError,
  };
}

/**
 * 本文の中身（string か、部品の配列）を文字列へ。
 *
 * OpenAI互換を名乗る上流でも、非ストリームの応答では content が
 * `[{type:"text",text:"…"}, {type:"image_url",image_url:{url:"…"}}]`
 * の形で来ることがある。文字列としてだけ読むと、そこに入っている
 * 画像も文章も丸ごと落ちて「本文のない応答」に見える。
 */
function flattenContent(value: unknown, imageUrls: string[]): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  let out = "";
  for (const part of value) {
    const p = part as Record<string, unknown> | null;
    if (typeof p?.text === "string") out += p.text;
    else if (typeof p === "string") out += p;
    const url = (p?.image_url as { url?: unknown } | undefined)?.url;
    if (typeof url === "string" && url) imageUrls.push(url);
  }
  return out;
}

/**
 * SSEではなく JSON を1つ返す上流を読む。
 *
 * 画像生成のモデルには stream に対応しないものがあり（API易の画像系は
 * 上流の文書で明言されている）、`stream: true` を付けても中継は普通の
 * JSON を返す。SSE として読むと `data: ` で始まる行が1つも無いまま
 * 終わるため、**本文も画像も使用量も全部落ちて「本文のない応答」**に
 * なる。画面には「モデルから本文のない応答が返りました」とだけ出て、
 * 上流では生成が終わって課金されている。
 */
export async function readUpstreamJson(
  body: ReadableStream<Uint8Array>,
  opts: { idleTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<StreamResult> {
  const reader = body.getReader();
  const readOnce = idleGuardedReader(
    reader,
    opts.idleTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS,
    opts.signal,
  );
  const decoder = new TextDecoder();
  const imageUrls: string[] = [];
  const citations: UiCitation[] = [];
  let text = "";
  let interrupted: string | undefined;

  try {
    for (;;) {
      const { done, value } = await readOnce();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (e) {
    interrupted = (e as Error).message || "接続が途中で切れました";
    try {
      await reader.cancel();
    } catch {
      // 既に閉じていれば何もしない
    }
  }
  text += decoder.decode();

  const empty: StreamResult = {
    content: "",
    reasoning: "",
    usageJson: null,
    imageUrls,
    citations,
    stopped: false,
    interrupted,
  };
  if (text.trim() === "") return empty;

  let parsed: {
    error?: unknown;
    choices?: {
      message?: { content?: unknown; reasoning?: unknown; images?: unknown; annotations?: unknown };
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
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    // JSONでもSSEでもない本文（手前のプロキシのHTMLなど）。何が返って
    // きたのか分からないまま「空の応答」にせず、先頭だけ理由に添える
    return {
      ...empty,
      interrupted:
        interrupted ??
        `上流の応答を解釈できませんでした: ${text.trim().slice(0, 200)}`,
    };
  }

  const choice = parsed.choices?.[0];
  const content = flattenContent(choice?.message?.content, imageUrls);
  collectImageUrls(choice?.message?.images, imageUrls);
  collectCitations(choice?.message?.annotations, citations);

  return {
    content,
    reasoning:
      typeof choice?.message?.reasoning === "string"
        ? choice.message.reasoning
        : "",
    usageJson: parsed.usage
      ? JSON.stringify({
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          cost: parsed.usage.cost,
          cachedTokens:
            parsed.usage.prompt_tokens_details?.cached_tokens ?? undefined,
          reasoningTokens:
            parsed.usage.completion_tokens_details?.reasoning_tokens ??
            undefined,
        })
      : null,
    imageUrls,
    citations,
    finishReason: choice?.finish_reason ?? undefined,
    stopped: false,
    interrupted,
    error:
      parsed.error && typeof parsed.error === "object"
        ? describeUpstreamError(parsed.error)
        : undefined,
  };
}

/**
 * 上流の応答を読む。SSEでも、JSONを1つ返す上流でも同じ形で返す。
 *
 * 見分けは Content-Type。分からないときは SSE として読む（今まで
 * 通っていた窓口の動きを変えないため）。
 */
export async function readUpstreamResponse(
  upstream: Response,
  onProgress?: (partial: {
    content: string;
    reasoning: string;
  }) => Promise<boolean>,
  opts: { idleTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<StreamResult> {
  const body = upstream.body;
  if (!body) {
    return {
      content: "",
      reasoning: "",
      usageJson: null,
      imageUrls: [],
      citations: [],
      stopped: false,
      interrupted: "上流が本文を返しませんでした",
    };
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (/json/i.test(contentType) && !/event-stream/i.test(contentType)) {
    return await readUpstreamJson(body, opts);
  }
  return await readUpstreamStream(body, onProgress, opts);
}

/** 例外を投げず、必ずメッセージ行を確定させて終了する。 */
export async function runSingleGeneration(job: GenerationJob): Promise<void> {
  const startedAt = Date.now();
  const provider = providerOf(job.model);
  const isPoe = provider === "poe";
  const modelName = bareModelName(job.model);
  /*
   * 画像を出すモデルは、応答ヘッダも本文の無音も長く待つ。
   *
   * 画像生成の上流は、画像ができるまでヘッダを返さないものがある
   * （Poe は実測で生成時間とほぼ同じ、API易の画像系は stream 自体に
   * 対応せず1回分をまとめて返す）。既定の60秒で切ると、上流では
   * 完了して課金されているのにこちらには何も残らない。生存確認
   * （heartbeat）は別に打っているので、待っても中断とはみなされない。
   */
  const imageTimeoutMs = job.imageOutput ? RETRY_ATTEMPT_DEADLINE_MS : undefined;
  // 1応答ぶんなので枠には十分収まるが、取り込む画像の枚数だけは
  // 上流しだいなので、リトライ生成と同じ数え方で歯止めをかけておく
  const budget = createBudget();

  let upstream: Response;
  try {
    // 添付画像はここでR2から読み出して data: URL に展開する
    // （DOのストレージに実体を持ち込まないため、ジョブにはIDだけを載せている）
    upstream = await requestUpstream(
      job,
      await expandAttachments(job.messages),
      budget.spend,
      { connectTimeoutMs: imageTimeoutMs },
    );
  } catch (e) {
    await finalizeGeneration(job.assistantMessageId, {
      content: "",
      reasoning: null,
      usageJson: null,
      status: "error",
      error: `${PROVIDER_LABELS[provider]}への接続に失敗しました: ${(e as Error).message}`,
    });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    await finalizeGeneration(job.assistantMessageId, {
      content: "",
      reasoning: null,
      usageJson: null,
      status: "error",
      error: await upstreamErrorMessage(upstream, provider),
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
    const { stopRequested, applied } = await flushGeneration(
      job.assistantMessageId,
      { content: latest.content, reasoning: latest.reasoning },
    );
    // 行が消えた・確定済みなら、読み続けても受け取る先が無い。
    // 停止と同じに扱って上流を切る（読み続けた分も課金される）
    return stopRequested || !applied;
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

  const result = await readUpstreamResponse(
    upstream,
    async (partial) => {
      latest = {
        content: partial.content,
        reasoning: partial.reasoning || null,
      };
      return await write();
    },
    { idleTimeoutMs: imageTimeoutMs },
  );
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

  // API易: 額は応答に載らない。価格表から見積もって台帳へ載せる
  // （足さないと cost も points も無い記録として丸ごと捨てられ、
  // 使用量の画面にも月間上限にも出てこない）
  usageJson = await applyApiyiCost(job.model, usageJson, budget.spend);

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

/** レート制限に当たったときの待ち時間。 */


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

/**
 * 1回の試行の結果。分け方の根拠は upstream-outcome.ts。
 */
export type AttemptOutcome =
  | {
      kind: "success";
      content: string;
      usageJson: string | null;
      imageUrls: string[];
    }
  /**
   * 断られた（画像が返らなかった応答、またはセーフティ判定のエラー）。
   * 投げ直す対象で、試行に数える。上流が返した usage も持つ——拒否文
   * にも課金されていて、捨てるとリトライ生成の支出の大半が台帳から消える。
   */
  | { kind: "refused"; text: string; usageJson: string | null }
  /**
   * 一時的な不調。待ってから投げ直し、試行には数えない。
   * waitMs は上流が申告した待ち時間。無ければ null（固定の待ちに落ちる）。
   */
  | { kind: "transient"; reason: string; waitMs: number | null }
  /** 直らない。その場で止める。 */
  | { kind: "fatal"; reason: string };

/**
 * 1回分の生成。成功の判定は「画像が1枚以上あるか」だけで、
 * 拒否文の文言は見ない（言語や表現に依存して壊れるため）。
 */
export async function runAttempt(
  job: GenerationJob,
  messages: OutgoingMessage[],
  /** 上流へ1件投げる直前に呼ばれる（枠と、実行全体の本数を数える）。 */
  onRequest: () => void,
  gate: RateLimitGate,
  /** 外からの打ち切り（総時間の締め切り・停止後の猶予切れ）。 */
  signal: AbortSignal,
  /**
   * 投げてから応答ヘッダが返るまでの時間を書き戻す先。
   *
   * 同時に投げられているかの物差し。「1回の呼び出しで応答ヘッダを同時に
   * 待てる接続は6本まで」に当たっていると、7本目以降はここが伸びる
   * （かかった時間だけでは、順番待ちなのか生成が遅いのか分からない）。
   */
  timing?: { headerMs?: number },
): Promise<AttemptOutcome> {
  const provider = providerOf(job.model);
  // 画像を出すモデルは、ヘッダも本文の無音も1本の締め切りまで待つ。
  // 画像生成は最初の1バイトまで長く黙る上流があり、Poe は画像ができ
  // 始めるまで応答ヘッダも返さない。短く切ると上流側では完了して課金
  // されるのに、こちらには何も残らない（「上流が応答ヘッダを返しません
  // でした」）。生存確認は別に打っているので、待っても中断とはみなされない
  const idleTimeoutMs = job.imageOutput
    ? RETRY_ATTEMPT_DEADLINE_MS
    : UPSTREAM_IDLE_TIMEOUT_MS;
  let upstream: Response;
  try {
    // 枠は requestUpstream の中で、投げるたびに数える
    // （サーバーツールが弾かれると2件投げるため）
    const startedAt = Date.now();
    upstream = await requestUpstream(job, messages, onRequest, {
      connectTimeoutMs: idleTimeoutMs,
      signal,
    });
    if (timing) timing.headerMs = Date.now() - startedAt;
  } catch (e) {
    // つながらない・ヘッダが来ない・こちらで切った。状態が無いので一時的
    return {
      kind: "transient",
      reason: `${PROVIDER_LABELS[provider]}への接続に失敗しました: ${(e as Error).message}`,
      waitMs: null,
    };
  }

  gate.note(upstream);

  if (!upstream.ok || !upstream.body) {
    const body = await readUpstreamError(upstream);
    const message = await upstreamErrorMessage(upstream, provider, body);
    const verdict = classifyUpstreamFailure({
      provider,
      status: upstream.status,
      type: body.type,
      message: body.detail,
      raw: body.raw,
    });
    if (verdict.kind === "refused") {
      return { kind: "refused", text: message, usageJson: null };
    }
    if (verdict.kind === "transient") {
      return {
        kind: "transient",
        reason: message,
        waitMs: upstream.status === 429 ? gate.waitAfter(upstream) : null,
      };
    }
    return { kind: "fatal", reason: message };
  }

  const result = await readUpstreamResponse(upstream, undefined, {
    idleTimeoutMs,
    signal,
  });
  // 額が応答に載らない窓口ぶんを、ここで見積もって足す。拒否の応答にも
  // 課金されており、リトライ生成では拒否が試行の大半を占める
  result.usageJson = await applyApiyiCost(job.model, result.usageJson, onRequest);
  const hasImage =
    result.imageUrls.length > 0 || extractImageUrls(result.content).length > 0;
  // 画像が揃っているなら、途中で切れていても成果は成果なので受け取る
  if (!hasImage && result.error) {
    // 200 のあとに本文の中で届いたエラー。HTTP のエラーと同じ分け方に通す
    const verdict = classifyUpstreamFailure({
      provider,
      status: result.error.code,
      type: result.error.type,
      message: result.error.detail,
      raw: result.error.raw,
    });
    const message =
      result.error.detail ||
      `${PROVIDER_LABELS[provider]}が応答の途中でエラーを返しました`;
    if (verdict.kind === "refused") {
      return { kind: "refused", text: message, usageJson: result.usageJson };
    }
    if (verdict.kind === "transient") {
      return { kind: "transient", reason: message, waitMs: null };
    }
    return { kind: "fatal", reason: message };
  }
  // 揃っていないのに切れた場合は「拒否」ではなく通信の失敗として扱う
  // （拒否として数えると、モデルが断ったのか回線が切れたのか分からなくなる）
  if (!hasImage && result.interrupted) {
    return {
      kind: "transient",
      reason: `応答が途中で切れました: ${result.interrupted}`,
      waitMs: null,
    };
  }
  return hasImage
    ? {
        kind: "success",
        content: result.content,
        usageJson: result.usageJson,
        imageUrls: result.imageUrls,
      }
    : { kind: "refused", text: result.content, usageJson: result.usageJson };
}

/**
 * 拒否された応答の支出を台帳へ載せる。
 *
 * 台帳への記録に失敗しても実行は続ける（課金は済んでいるので、記録の
 * 失敗で走っている分を失うほうが害が大きい）。黙りはしない。
 */
export async function recordRefusalUsage(
  modelId: string,
  usageJson: string | null,
): Promise<void> {
  if (!usageJson) return;
  try {
    const u = JSON.parse(usageJson) as Record<string, unknown>;
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    await recordStandaloneUsage({
      kind: "retry",
      modelId,
      costUsd: num(u.cost),
      promptTokens: num(u.promptTokens),
      completionTokens: num(u.completionTokens),
    });
  } catch (e) {
    console.error("[usage] 拒否された応答の台帳への記録に失敗しました", e);
  }
}
