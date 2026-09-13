/**
 * Runware — 4つ目の窓口。画像だけ。
 *
 * これまでの3つと違い、OpenAI互換ではない。**依頼は「作業（task）の
 * 配列」で、応答も配列**（1回の呼び出しに複数の作業を載せられる）。
 * 会話という概念は無く、送れるのは依頼文1本と参照画像だけ。
 *
 * ## 扱うモデルは3本だけ。表はここに置く
 *
 * 他の窓口（API易）はモデル名を環境変数で受け取るが、この窓口は
 * **「この3本だけ」と決めて表をコードに持つ**。上流のモデルは1本ずつ
 * 受け付けるパラメータが違い、名前を外から渡せるようにすると
 * 「どのモデルが何を受けるか」まで外から言ってもらうことになるため
 * （実際、審査の設定の置き場が世代で違う——下記）。
 *
 * このリポジトリには「モデル名・モデル ID を書かない」決まりごとが
 * あるが、この表はその例外にする（CLAUDE.md にも書いてある）。
 * 決まりごとを守ったままにすると、鍵に加えてモデルの指定と世代の印まで
 * 環境変数へ手で書くことになり、書き間違いが**審査の設定が黙って
 * 効かない**という形で出る。
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
 * かかったままになる。表の `providerSettings` がその置き場を決める。
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

/** 品質の段。`auto` は⚙の「自動」（＝送らない）に当たるので入れない。 */
const QUALITY_BASE = ["low", "medium", "high"];
const QUALITY_EXTENDED = [...QUALITY_BASE, "xhigh", "max"];

/** 一覧に載せるモデル1本。 */
export interface RunwareModel {
  /** 上流のモデル識別子（`creator:family@version`）。 */
  air: string;
  /** 一覧に出す名前。 */
  label: string;
  /** 審査・品質を `providerSettings.<creator>` へ置く世代か。 */
  providerSettings: boolean;
  /** このモデルが受け付ける品質の段（上流の文書にあるものだけ）。 */
  quality: string[];
}

/**
 * 扱うモデル。増やすときはここへ足す。
 *
 * 品質の段はモデルごとに違う。広いほうを一律に出すと、受け付けない
 * モデルで選んだときに 400 になり、**その1本をまるごと失う**。
 */
export const RUNWARE_MODELS: readonly RunwareModel[] = [
  {
    air: "openai:gpt-image@2",
    label: "GPT Image 2",
    // この世代だけ、審査と品質が providerSettings 側
    providerSettings: true,
    quality: QUALITY_BASE,
  },
  {
    air: "openai:gpt-image@2.5-flare",
    label: "GPT-Image-2.5 Flare",
    providerSettings: false,
    quality: QUALITY_EXTENDED,
  },
  {
    air: "openai:gpt-image@2.5-sunburst",
    label: "GPT-Image-2.5 Sunburst",
    providerSettings: false,
    quality: QUALITY_EXTENDED,
  },
];

/**
 * 表に無いモデルの扱い。
 *
 * 表から外したモデルが会話に残っていることがある（過去のやり取りを
 * 開いて、そのまま送り直せる）。生成そのものは通し、置き場は新しい
 * ほう、品質は広いほうを許す——ここで弾くと、過去の会話が黙って
 * 送信できなくなる。
 */
const UNKNOWN_MODEL: Omit<RunwareModel, "air" | "label"> = {
  providerSettings: false,
  quality: QUALITY_EXTENDED,
};

/**
 * モデル識別子の供給元（`creator:family@version` の `creator`）。
 *
 * 古い置き場の入れ子の名前はこれで決まる。表に無いモデルでも組み立て
 * られるよう、識別子そのものから取り出す。
 */
export function runwareCreatorOf(air: string): string {
  const head = air.split(":")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9_-]+$/.test(head) ? head : "";
}

/** 表からモデルを引く。無ければ上の既定。 */
export function runwareModelOf(air: string): Omit<RunwareModel, "label"> {
  return RUNWARE_MODELS.find((m) => m.air === air) ?? { air, ...UNKNOWN_MODEL };
}

/** 一覧に出す1本。 */
export function buildRunwareModelInfo(model: RunwareModel): ModelInfo {
  return {
    id: `${RUNWARE_PREFIX}${model.air}`,
    name: model.label,
    description: "Runware（画像生成・従量）",
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
    // ⚙に出す品質の段。クライアントは表を読めないのでここへ載せる
    runwareQuality: model.quality,
    createdAt: 0,
  };
}

/** Runware のモデル一覧。鍵が無ければ空（任意の機能）。 */
export async function fetchRunwareModels(): Promise<ModelInfo[]> {
  if (!env.RUNWARE_API_KEY) return [];
  return RUNWARE_MODELS.map(buildRunwareModelInfo);
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
 *
 * 置き場と品質の段は、呼ぶ側から受け取らず**ここで表を引く**。渡す形に
 * すると、呼ぶ側が引き忘れて既定のまま渡しても型では気づけない
 * （どちらも同じ型なので、審査が黙って効かなくなる）。
 */
export function runwareImageTaskBody(
  req: RunwareImageRequest,
): Record<string, unknown>[] {
  const model = runwareModelOf(req.model);
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
  // 品質はモデルごとに受け付ける段が違う。⚙は表に沿った選択肢しか
  // 出さないが、設定は会話に付いたままモデルを乗り換えられるので、
  // 段の少ないモデルへ乗り換えたときに古い値が残る
  if (
    typeof req.params.quality === "string" &&
    model.quality.includes(req.params.quality)
  ) {
    tuning.quality = req.params.quality;
  }

  const settings: Record<string, unknown> = {
    ...(background != null ? { background } : {}),
    ...(model.providerSettings ? {} : tuning),
  };
  const creator = runwareCreatorOf(req.model);
  const providerSettings =
    model.providerSettings && creator && Object.keys(tuning).length > 0
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
