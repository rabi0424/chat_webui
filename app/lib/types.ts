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
    promptTokens: number;
    completionTokens: number;
    cost?: number;
    /** キャッシュから読み取られた入力トークン数（プロンプトキャッシング）。 */
    cachedTokens?: number;
    /** 思考（reasoning）に使われた出力トークン数。 */
    reasoningTokens?: number;
  };
  /** 応答生成に使ったモデルID（アシスタントのみ）。 */
  modelId?: string;
  /** 作成時刻（生成開始時刻）。 */
  createdAt?: number;
  /** 生成完了時刻。所要時間の算出に使う。 */
  finishedAt?: number;
  /** この位置の兄弟ブランチ（自分を含む、作成順）。分岐点でのみ2件以上になる。 */
  siblingIds?: string[];
  /** siblingIds の中での自分の位置。 */
  siblingIndex?: number;
}
