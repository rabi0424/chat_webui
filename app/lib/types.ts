/** チャット画面で扱うメッセージ。サーバー/クライアント共用。 */
export interface UiMessage {
  /** DB上のID。未保存メッセージでは undefined。 */
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  usage?: { promptTokens: number; completionTokens: number; cost?: number };
  /** この位置の兄弟ブランチ（自分を含む、作成順）。分岐点でのみ2件以上になる。 */
  siblingIds?: string[];
  /** siblingIds の中での自分の位置。 */
  siblingIndex?: number;
}
