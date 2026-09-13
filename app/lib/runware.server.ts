/**
 * Runware — 4つ目の窓口。画像だけ。
 *
 * これまでの3つと違い、OpenAI互換ではない。**依頼は「作業（task）の
 * 配列」で、応答も配列**（1回の呼び出しに複数の作業を載せられる）。
 * 会話という概念は無く、送れるのは依頼文1本と参照画像だけ。
 *
 * 一覧に載せるモデルは環境変数 `RUNWARE_MODELS` で指定する。決め打ちに
 * しない理由は API易 と同じ（上流のモデルは予告なく増減する／モデル名を
 * リポジトリへ置かない）。
 *
 * ## 世代で置き場が変わる
 *
 * 審査の強さ（moderation）と品質（quality）は、**モデルの世代によって
 * 置き場所が違う**。新しい世代は `settings` の直下、古い世代は
 * `providerSettings.<creator>` の中（`creator` はモデル識別子の `:` の
 * 手前＝供給元の名前）。上流の文書がモデルごとにそう書いており、
 * こちらから問い合わせる手立ては無い（モデル検索の応答にも載らない）。
 *
 * 取り違えると**審査の設定が黙って効かない**か、知らない項目として
 * 400 になる。前者のほうが厄介——絵は出るのに、緩めたはずの判定が
 * かかったままになる。そこで置き場は推測せず、環境変数の指定で決める:
 *
 *   RUNWARE_MODELS="creator:family@version, creator:family@ver|providerSettings"
 *
 * 何も添えなければ新しい置き場（`settings`）。`|providerSettings` を
 * 添えたものだけ古い置き場へ入れる。知らない語を添えたときは一覧には
 * 出すが、説明にその旨を出す（黙って既定へ倒すと、設定が効いていない
 * ことに気づけない）。
 */
import { env } from "cloudflare:workers";
import { RUNWARE_PREFIX } from "./constants";
import { RUNWARE_IMAGE_PARAM_KEYS } from "./params";
import type { ModelInfo } from "./openrouter.server";
import {
  UPSTREAM_CONNECT_TIMEOUT_MS,
  fetchAwaitingHeaders,
} from "./upstream-fetch.server";

/** 唯一の受け口。作業の種類にかかわらずここへ POST する。 */
const RUNWARE_ENDPOINT = "https://api.runware.ai/v1";

/** 参照画像の上限（上流の制限）。 */
const MAX_REFERENCE_IMAGES = 16;

/**
 * 縦横を指定しなかったときの大きさ。
 *
 * 上流は `width`/`height` を**必須**にしているので、⚙が「自動」でも
 * 何かを送るしかない（他の項目のように「送らない＝上流の既定」に
 * できない）。1:1 の推奨値を使う。
 */
const DEFAULT_SIZE = { width: 1024, height: 1024 };

/** 古い置き場を指定する語（`RUNWARE_MODELS` の1件に添える）。 */
const PROVIDER_SETTINGS_OPTION = "providersettings";

/** 一覧に載せるモデル1本。 */
export interface RunwareModelSpec {
  /** 上流のモデル識別子（`creator:family@version`）。 */
  air: string;
  /** 審査・品質を `providerSettings.<creator>` へ置くモデルか。 */
  providerSettings: boolean;
  /** 解釈できなかった指定（あれば画面へ出す）。 */
  unknownOption?: string;
}

/**
 * モデル識別子の供給元（`creator:family@version` の `creator`）。
 *
 * 古い置き場の入れ子の名前はこれで決まる。モデル名をコードへ書かない
 * ために、識別子そのものから取り出す。
 */
export function runwareCreatorOf(air: string): string {
  const head = air.split(":")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9_-]+$/.test(head) ? head : "";
}

/**
 * `RUNWARE_MODELS` の中身を読む。
 *
 * 区切りはカンマ・空白・改行のどれでもよい（設定画面ではなく環境変数へ
 * 手で書く値なので、区切りを間違えて全部が1件になると「一覧に出ない」
 * という形でしか分からない）。1件に `|` で指定を添えられる。
 */
export function parseRunwareModelSpecs(
  raw: string | undefined,
): RunwareModelSpec[] {
  if (!raw) return [];
  const out: RunwareModelSpec[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const [head, ...rest] = part.split("|");
    const air = head.trim();
    if (!air || seen.has(air)) continue;
    seen.add(air);
    const option = rest.join("|").trim();
    out.push({
      air,
      providerSettings: option.toLowerCase() === PROVIDER_SETTINGS_OPTION,
      unknownOption:
        option && option.toLowerCase() !== PROVIDER_SETTINGS_OPTION
          ? option
          : undefined,
    });
  }
  return out;
}

/**
 * 生成のときに、そのモデルの指定を引き直す。
 *
 * 生成は Durable Object の中で走り、そこにはモデル一覧が無い（一覧を
 * 取り直すのはサブリクエストの無駄）。環境変数を読むだけで足りるので、
 * ここで引く。一覧から外されたモデルが会話に残っていることもあるため、
 * 見つからなければ既定（新しい置き場）とみなす。
 */
export function findRunwareSpec(
  specs: RunwareModelSpec[],
  air: string,
): RunwareModelSpec {
  return specs.find((s) => s.air === air) ?? { air, providerSettings: false };
}

/** 上と同じものを、環境変数から引く。 */
export function runwareSpecOf(air: string): RunwareModelSpec {
  return findRunwareSpec(parseRunwareModelSpecs(env.RUNWARE_MODELS), air);
}

/** 一覧に出す1本。 */
export function buildRunwareModelInfo(spec: RunwareModelSpec): ModelInfo {
  const warning = spec.unknownOption
    ? `／指定「${spec.unknownOption}」は解釈できませんでした`
    : "";
  return {
    id: `${RUNWARE_PREFIX}${spec.air}`,
    name: spec.air,
    description: `Runware（画像生成・従量${warning}）`,
    // 上流はコンテキスト長を持たない。0 は画面側で「出さない」印
    contextLength: 0,
    // 単価は出来上がり（トークン数）で決まり、こちらでは分からない。
    // 応答に実費（cost）が載るので、額はそちらから台帳へ入れる
    promptPrice: "0",
    completionPrice: "0",
    // 参照画像を渡して直させられる
    inputModalities: ["text", "image"],
    outputModalities: ["text", "image"],
    supportedParameters: [...RUNWARE_IMAGE_PARAM_KEYS],
    provider: "runware",
    runwareProviderSettings: spec.providerSettings,
    createdAt: 0,
  };
}

/** Runware のモデル一覧。鍵か指定が無ければ空（任意の機能）。 */
export async function fetchRunwareModels(): Promise<ModelInfo[]> {
  if (!env.RUNWARE_API_KEY) return [];
  return parseRunwareModelSpecs(env.RUNWARE_MODELS).map(buildRunwareModelInfo);
}

/** 1回の生成依頼。 */
export interface RunwareImageRequest {
  /** 接頭辞を外したモデル識別子。 */
  model: string;
  prompt: string;
  /**
   * 参照画像。data: URL のまま渡せる（上流は UUID・URL・データURI・
   * base64 のどれでも受ける）ので、復号して詰め直さない。
   */
  referenceImages: string[];
  /** ⚙で手動にした値（`buildGenerationPayload` の平らな出力）。 */
  params: Record<string, unknown>;
  /** 審査・品質の置き場。 */
  providerSettings: boolean;
  /** 作業の識別子。上流は UUID v4 を要求する。 */
  taskUUID: string;
}

/** "1536x1024" → { width, height }。読めなければ既定。 */
function sizeOf(raw: unknown): { width: number; height: number } {
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(typeof raw === "string" ? raw : "");
  if (!m) return DEFAULT_SIZE;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * 依頼の本文（作業の配列）を組み立てる。鍵には触らない。
 *
 * 鍵を足すところと分けてあるのは、ここだけをテストから通せるように
 * するため。入れ子を1つ間違えても返ってくるのは 400 か、**何事も無く
 * 効かない設定**で、画面からは見分けが付かない。
 */
export function runwareImageTaskBody(
  req: RunwareImageRequest,
): Record<string, unknown>[] {
  const { width, height } = sizeOf(req.params.size);
  const background = req.params.background;
  let format = req.params.output_format;

  /*
   * 背景を指定するなら形式も要る（上流の決まり）。透過を頼んだのに
   * JPG のままだと弾かれるので、透過のときは PNG に寄せる。
   * 「透過を選んだのに 400 で1本失う」より、形式を寄せるほうがよい。
   */
  if (background === "transparent" && format !== "WEBP") format = "PNG";
  if (background != null && format == null) format = "PNG";

  /** 審査と品質。置き場は世代で変わる（このモジュール冒頭の注記）。 */
  const tuning: Record<string, unknown> = {};
  if (typeof req.params.moderation === "string") {
    tuning.moderation = req.params.moderation;
  }
  if (typeof req.params.quality === "string") {
    tuning.quality = req.params.quality;
  }

  const settings: Record<string, unknown> = {
    ...(background != null ? { background } : {}),
    ...(req.providerSettings ? {} : tuning),
  };
  const creator = runwareCreatorOf(req.model);
  const providerSettings =
    req.providerSettings && creator && Object.keys(tuning).length > 0
      ? { [creator]: tuning }
      : undefined;

  const refs = req.referenceImages.slice(0, MAX_REFERENCE_IMAGES);
  return [
    {
      taskType: "imageInference",
      taskUUID: req.taskUUID,
      model: req.model,
      positivePrompt: req.prompt,
      width,
      height,
      numberResults: 1,
      // URL で受け取る。データURIで受け取ると、4K の1枚で本文が数MBに
      // なり、読み取りの上限にも近づく。取りに行く1件はこちらの
      // サブリクエストの枠から出るが、その分は数えてある
      outputType: "URL",
      ...(format != null ? { outputFormat: format } : {}),
      ...(req.params.output_compression != null
        ? { outputQuality: req.params.output_compression }
        : {}),
      // 額は応答に載せてもらう。載らないと台帳から丸ごと落ちる
      includeCost: true,
      // 非同期にすると結果を別途取りに行くことになる（実行体が起きて
      // いる時間がそのぶん増える）。1枚を待って受け取るほうを採る
      deliveryMethod: "sync",
      ...(refs.length > 0 ? { inputs: { referenceImages: refs } } : {}),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(providerSettings ? { providerSettings } : {}),
    },
  ];
}

export async function runwareImageRequest(
  req: Omit<RunwareImageRequest, "taskUUID"> & { taskUUID?: string },
  connectTimeoutMs: number = UPSTREAM_CONNECT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Response> {
  const body = runwareImageTaskBody({
    ...req,
    taskUUID: req.taskUUID ?? crypto.randomUUID(),
  });
  return await fetchAwaitingHeaders(
    RUNWARE_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RUNWARE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    connectTimeoutMs,
    signal,
  );
}

/** 応答の作業1件（読む項目だけ）。 */
interface RunwareResultItem {
  imageURL?: unknown;
  imageDataURI?: unknown;
  imageBase64Data?: unknown;
  cost?: unknown;
}

/**
 * 応答の `data` から画像と実費を取り出す。
 *
 * 画像は URL で受け取る指定にしているが、上流は指定によって
 * `imageDataURI`・`imageBase64Data` でも返せる。どれで来ても同じ経路
 * （生成画像の取り込み）へ渡せる形に揃える。
 *
 * 額は作業ごとに載る。1回で複数枚頼めるので**足し合わせる**——先頭
 * だけを読むと、枚数を増やしたときに台帳だけが実際より安くなる。
 */
export function readRunwareData(items: unknown): {
  imageUrls: string[];
  costUsd: number | null;
} {
  const imageUrls: string[] = [];
  let cost: number | null = null;
  if (!Array.isArray(items)) return { imageUrls, costUsd: cost };
  for (const raw of items) {
    const item = (raw ?? {}) as RunwareResultItem;
    const url =
      typeof item.imageURL === "string" && item.imageURL
        ? item.imageURL
        : typeof item.imageDataURI === "string" && item.imageDataURI
          ? item.imageDataURI
          : typeof item.imageBase64Data === "string" && item.imageBase64Data
            ? // 接頭辞が付かない base64。data: URL の形にすれば、あとは
              // 他の窓口の生成画像と同じ経路で取り込める（R2 へ入れる
              // 型は中身から決め直される）
              `data:image/png;base64,${item.imageBase64Data}`
            : "";
    if (url) imageUrls.push(url);
    const n = Number(item.cost);
    if (Number.isFinite(n)) cost = (cost ?? 0) + n;
  }
  return { imageUrls, costUsd: cost };
}

/**
 * 応答の `errors` を、他の窓口のエラーと同じ形へ。
 *
 * この窓口は `error` ではなく **`errors` の配列**で返し、`code` は
 * 数値ではなく `invalidApiKey` のような文字列。他の窓口と同じ読み方を
 * すると、**理由がどこにも出ないまま「本文のない応答」**になる。
 */
export function runwareErrorOf(
  body: unknown,
): { detail: string; type: string | null; code: number | null; raw: string } | undefined {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const first = (errors[0] ?? {}) as {
    code?: unknown;
    message?: unknown;
    parameter?: unknown;
  };
  const detail = typeof first.message === "string" ? first.message : "";
  const parameter =
    typeof first.parameter === "string" && first.parameter
      ? `（${first.parameter}）`
      : "";
  let raw: string;
  try {
    raw = JSON.stringify(errors[0] ?? "");
  } catch {
    raw = "";
  }
  return {
    detail: detail ? `${detail}${parameter}` : "",
    // 文字列の code はこちらの type に当たる（判定には使わず、要約に出す）
    type: typeof first.code === "string" ? first.code : null,
    code: null,
    raw,
  };
}
