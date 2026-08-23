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

/** 生成せずに保存したユーザー発言。採番されたIDを返す。 */
export interface AppendMessageResponse {
  id: string;
}

/** 生成の開始。採番されたIDを返す（クライアントの楽観表示に貼る）。 */
export interface GenerateResponse {
  /** 新しいユーザー発言を保存しなかったときは null。 */
  userMessageId: string | null;
  assistantMessageId: string;
}

/** サイドバーの印（未読と、いま生成中の会話）。 */
export interface UnreadResponse {
  /** 未読の会話ID。 */
  ids: string[];
  /** いま生成が走っている会話ID。 */
  generating: string[];
  /**
   * 会話一覧で最後に何かが動いた時刻。
   *
   * これが変わったときだけ一覧を取り直す（毎回引くと、表示しているあいだ
   * ずっと200行の読み出しが続く）。
   */
  latest: number;
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

/**
 * 受け付けるメソッドを確かめる。通れば null、通らなければ 405 を返す。
 *
 * 許すメソッドの一覧をここへ1度だけ書き、405 の Allow ヘッダも同じ
 * 一覧から作る。以前は「分岐で見るメソッド」と「405 の応答」が別々に
 * 書かれていて、**受け口を増やしても Allow は古いまま**にできた。
 * 405 に Allow を付けるのは HTTP の決まり（RFC 9110）でもある。
 *
 * 更新は PATCH に揃える（監査 C-1）。同じ「一部を書き換える」操作が
 * ルートによって PUT だったり POST も受けたりしていた。呼ぶ側は
 * ルートごとに正解を覚えることになり、間違えても 405 が返るだけで
 * 理由は分からない。
 */
export function requireMethod(
  request: Request,
  allowed: readonly string[],
): Response | null {
  if (allowed.includes(request.method)) return null;
  return Response.json(
    { error: "Method Not Allowed" } satisfies ErrorResponse,
    { status: 405, headers: { Allow: allowed.join(", ") } },
  );
}
