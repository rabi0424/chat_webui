/** メッセージに添付された画像。実体は /api/files/:id で取得する。 */
export interface UiAttachment {
  id: string;
  mimeType: string;
  name: string | null;
  size: number;
}

/** チャット画面で扱うメッセージ。サーバー/クライアント共用。 */
export interface UiMessage {
  /** DB上のID。未保存メッセージでは undefined。 */
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** thinking対応モデルの思考内容（あれば折りたたみ表示する）。 */
  reasoning?: string;
  /** サーバー側生成の状態。undefined = 完了済み（通常）。 */
  status?: "streaming" | "error";
  /** status === "error" のときのエラーメッセージ。 */
  error?: string;
  usage?: {
    /** トークン数はAPIがusageを返さない場合（Poe等）undefinedになりうる。 */
    promptTokens?: number;
    completionTokens?: number;
    /** ドル建てコスト（OpenRouter、またはPoeのUSD換算額）。 */
    cost?: number;
    /** Poe: この応答で消費したポイント。 */
    points?: number;
    /** キャッシュから読み取られた入力トークン数（プロンプトキャッシング）。 */
    cachedTokens?: number;
    /** 思考（reasoning)に使われた出力トークン数。 */
    reasoningTokens?: number;
  };
  /** 応答生成に使ったモデルID（アシスタントのみ）。 */
  modelId?: string;
  /** 作成時刻（生成開始時刻）。 */
  createdAt?: number;
  /** 生成完了時刻。所要時間の算出に使う。 */
  finishedAt?: number;
  /**
   * このメッセージの直後にコンテキストの境界線がある。
   * ここまでの発言は以後の生成でモデルへ送らない（履歴には残る）。
   */
  contextBoundary?: boolean;
  /** この位置の兄弟ブランチ（自分を含む、作成順）。分岐点でのみ2件以上になる。 */
  siblingIds?: string[];
  /** siblingIds の中での自分の位置。 */
  siblingIndex?: number;
  /** 添付画像（ユーザーメッセージのみ）。 */
  attachments?: UiAttachment[];
}
