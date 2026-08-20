/**
 * APIの応答の形。サーバーとクライアントの両方がここを見る。
 *
 * これまでは呼び出し側が `(await res.json()) as { … }` と手で書いて
 * いた。サーバーの返す形とは何も結び付いていないので、ルート側の
 * 変更がコンパイルエラーにならず、実行して初めて気づくことになる
 * （実際、ボットの params の型は number だけを書いていて、文字列を
 * 取る項目が型の上から落ちていた）。
 *
 * ルート側は `apiJson<T>()` で返し、呼び出し側は同じ型で読む。
 * どちらか一方だけ変えると型が合わなくなる。
 */
import type {
  ConversationRow,
  GeneratedImageRow,
  SearchResult,
} from "./db.server";
import type { ModelInfo } from "./openrouter.server";
import type { UiMessage } from "./types";

/** 表示中のパス（会話ツリーのうち、いま見えている一本道）。 */
export interface PathResponse {
  messages: UiMessage[];
}

/** 会話画面をまとめて読む入口（先読みキャッシュもこの形で持つ）。 */
export interface FullConversationResponse {
  conversation: ConversationRow;
  messages: UiMessage[];
}

/** 生成中メッセージ1件の最新状態。 */
export interface MessageStateResponse {
  content: string;
  reasoning: string | null;
  status: string;
  error: string | null;
  usage: UiMessage["usage"] | null;
  citations: UiMessage["citations"] | null;
}

/** 会話の作成。 */
export interface CreateConversationResponse {
  id: string;
}

/** 生成の開始。採番されたIDを返す（クライアントの楽観表示に貼る）。 */
export interface GenerateResponse {
  /** 新しいユーザー発言を保存しなかったときは null。 */
  userMessageId: string | null;
  assistantMessageId: string;
}

/** 未読の会話。 */
export interface UnreadResponse {
  ids: string[];
}

/** モデル一覧。 */
export interface ModelsResponse {
  models: ModelInfo[];
}

/** 為替（コスト表示の円換算に使う）。 */
export interface FxResponse {
  usdJpy: number | null;
}

/** 画像一覧。 */
export interface ImagesResponse {
  images: GeneratedImageRow[];
}

/** アップロードした添付。 */
export interface UploadResponse {
  id: string;
  mimeType: string;
  name: string | null;
  size: number;
}

/** 会話の検索結果。 */
export interface SearchResponse {
  results: SearchResult[];
}

/** 更新系の応答（成否だけを返すもの）。 */
export interface OkResponse {
  ok: true;
}

/** エラーの応答。すべてのルートでこの形に揃える。 */
export interface ErrorResponse {
  error: string;
}

/**
 * 型を決めて応答を返す。
 *
 * `Response.json` をそのまま呼ぶと引数は any 相当で、形が違っても
 * 通ってしまう。ここを通すことで、宣言した型からずれた瞬間に
 * ルート側がコンパイルエラーになる。
 */
export function apiJson<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/** エラー応答。文言と状態コードだけを渡す。 */
export function apiError(message: string, status: number): Response {
  return Response.json({ error: message } satisfies ErrorResponse, { status });
}
