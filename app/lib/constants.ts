/**
 * サーバーとクライアントの両方が見る決まりごと。
 *
 * ここに置く理由は、片側だけ変えたときに検証がすり抜けるのを防ぐため。
 * これまで添付の上限枚数と受け入れるMIMEは、サーバー専用モジュール
 * （r2.server.ts）とクライアント側（image.ts・Chat.tsx）で別々に
 * 書かれていて、「揃えること」をコメントで頼んでいた。サーバー専用の
 * モジュールはクライアントから読めないので、置き場所のほうが原因だった。
 */

/** 画像として受け入れるMIMEタイプ。LLM各社が共通で扱える形式に限定する。 */
export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** 1ファイルあたりの上限。これ以上はクライアント側で縮小してから送る。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 1メッセージに添付できる枚数の上限。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/*
 * 生成画像の縮小版（一覧のサムネイル）。
 *
 * 作るのはブラウザ。Workers は無料プランの CPU 上限が1回 10ms で
 * 1024px の画像のデコードと縮小には足りず、Cloudflare のリサイズは
 * 有料。原寸を最初に表示したブラウザは既にデコード済みの画像を
 * 持っているので、そこから縮小して R2 へ置く（lib/thumbnail.ts）。
 *
 * 大きさは短い辺を 512px にする。一覧のマスは iPhone で 130pt × 3倍
 * ＝ 390px、Mac で 200px × 2倍 ＝ 400px の正方形（中央を切り出す）
 * なので、短い辺が 512px あれば 1.3 倍の余裕がある。長い辺は
 * 横長の画像で無駄に大きくならないよう 1536px で切る。
 */
export const THUMBNAIL_SHORT_SIDE = 512;
export const THUMBNAIL_LONG_SIDE_MAX = 1536;
/** 縮小版の圧縮の品質（0〜1）。一覧で粗さが見えない水準。 */
export const THUMBNAIL_QUALITY = 0.88;
/** 縮小版として受け付ける形式（ブラウザの canvas が出せるもの）。 */
export const THUMBNAIL_TYPES = ["image/webp", "image/jpeg"];
/** 縮小版の上限。512×1536 の WebP でも 300KB には届かない。 */
export const THUMBNAIL_MAX_BYTES = 600 * 1024;
/** 縮小版の R2 キー。原寸のキーから機械的に決まる（列を増やさない）。 */
export const thumbnailKeyOf = (r2Key: string): string => `${r2Key}.thumb`;

/**
 * 会話のタイトルに使う長さの上限。
 * 保存する側（API）と、送信時に仮のタイトルを作る側で揃える。
 */
export const MAX_TITLE_LENGTH = 60;

/**
 * 画像一覧を一度に読む枚数。
 *
 * 一覧のルート（images.tsx）と続き読みのAPI（api.images.ts）が**同じ値を
 * 使わないと壊れる**。一覧は「返ってきた枚数がこれ未満なら終端」と
 * 判断しているので、APIのほうが小さいと1ページ読んだだけで
 * 「もう無い」と決めつけ、続きが読めなくなる。画面には何も出ない
 * 壊れ方なので、値そのものを1箇所に置いて分かれないようにする。
 *
 * 枚数は原寸の枚数でもある。この一覧はサムネイルを持たず原寸を並べる
 * ため、1枚が1〜2MBになりうる。60枚だと初回だけで100MB近く読むことに
 * なるので、少なめにして続きはスクロールで足す。
 */
export const IMAGES_PAGE_SIZE = 30;

/** モデルを選んでいないときに使うモデル。 */
export const DEFAULT_MODEL = "openai/gpt-4o-mini";

/**
 * 会話のタイトルを付けるためのモデル。
 * 本文の生成には使わないので、安く速いものを選ぶ。
 */
export const TITLE_MODEL = "openai/gpt-4o-mini";

/**
 * Poe のモデルは "poe:" を付けたIDで扱う。
 *
 * 判定はサーバー（生成・使用量の記録）とクライアント（画面の出し分け）の
 * 両方で要る。openrouter.server.ts に置いていたころは、クライアント側が
 * 文字列を書き写していた。
 */
export const POE_PREFIX = "poe:";

/** API易（apiyi）のモデルも同じく接頭辞で分ける。 */
export const APIYI_PREFIX = "apiyi:";

/**
 * 窓口（上流のサービス）。
 *
 * 接頭辞の付かないIDは OpenRouter。窓口が2つだったころは
 * `isPoeModel(id) ? "poe" : "openrouter"` という二分岐が台帳の記録・
 * 画面の出し分け・パラメータの組み立てに散らばっていて、3つ目を足すと
 * **どこか1つを直し忘れても型では気づけない**（どちらも文字列を返す
 * ので、足りない分岐は黙って "openrouter" に落ちる）。判定はここだけに
 * 置き、呼ぶ側は必ずこの関数を通す。
 */
export type ModelProvider = "openrouter" | "poe" | "apiyi";

/**
 * 接頭辞と窓口の対応。増やすときはここだけを足す。
 *
 * 台帳の provider 列も同じ表から組み立てる（schema.ts の
 * providerCaseSql）。SQL 側に書き写すと、接頭辞を足しても列だけが
 * 古いまま——**画面にはエラーが出ず、使用量の内訳だけが静かに
 * 間違う**という壊れ方をする。
 */
export const MODEL_PREFIXES: readonly (readonly [ModelProvider, string])[] = [
  ["poe", POE_PREFIX],
  ["apiyi", APIYI_PREFIX],
];

/** そのモデルIDがどの窓口のものか。 */
export function providerOf(modelId: string | null | undefined): ModelProvider {
  if (typeof modelId === "string") {
    for (const [provider, prefix] of MODEL_PREFIXES) {
      if (modelId.startsWith(prefix)) return provider;
    }
  }
  return "openrouter";
}

/** 接頭辞を外した、上流へそのまま投げるモデル名。 */
export function bareModelName(modelId: string): string {
  for (const [, prefix] of MODEL_PREFIXES) {
    if (modelId.startsWith(prefix)) return modelId.slice(prefix.length);
  }
  return modelId;
}

/** そのモデルIDが Poe のものか。 */
export function isPoeModel(modelId: string | null | undefined): boolean {
  return providerOf(modelId) === "poe";
}

/** そのモデルIDが API易 のものか。 */
export function isApiyiModel(modelId: string | null | undefined): boolean {
  return providerOf(modelId) === "apiyi";
}

/**
 * Web検索・URLの読み取りを使えるモデルか。
 *
 * これは OpenRouter 固有の機能（検索プラグインとサーバーツール）で、
 * 他の窓口には相当するものが無い。「Poe ではない」で判定していると、
 * 窓口が増えたときに**送っても効かないフラグが立ち**、上流によっては
 * 知らないフィールドとして 400 になる。
 */
export function supportsWebSearch(modelId: string | null | undefined): boolean {
  return providerOf(modelId) === "openrouter";
}

/** 窓口の表示名。エラー文言と画面の両方で使う。 */
export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  openrouter: "OpenRouter",
  poe: "Poe",
  apiyi: "API易",
};

/**
 * この端末で最後に使ったモデル（localStorage の鍵）。
 *
 * 設定画面の既定より**こちらが優先される**。選び直したモデルが次の
 * チャットでも続くのは、切り替えながら使う上で欠かせないため。
 * ただしそのぶん「設定を変えても画面が変わらない」ことが起きるので、
 * 設定画面はこの値を読んで、いま効いている側を出す。
 */
export const MODEL_STORAGE_KEY = "chat-webui:model";
