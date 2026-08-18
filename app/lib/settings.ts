/**
 * アプリ全体の設定。サーバー/クライアント共用の定義。
 *
 * テーマやアクセント色は端末ごとの好みなので localStorage に置いているが、
 * ここに入るのは課金や上流への負荷に効くもの（＝端末をまたいで効いて
 * ほしいもの）。実体は D1 の meta テーブルに1行のJSONとして持つ
 * （読み書きは db.server.ts）。
 */
export interface AppSettings {
  /**
   * リトライ生成で許可する試行回数の天井。
   * 会話ごとの設定はこの値を超えられない。
   */
  retryAttemptCeiling: number;
  /**
   * モデル一覧で「NEW」を出す日数（公開日からの経過日数）。
   * 0 にすると新着の強調をしない。
   */
  newModelDays: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  retryAttemptCeiling: 100,
  newModelDays: 3,
};

/** 天井として受け付ける範囲。 */
export const RETRY_CEILING_RANGE = { min: 1, max: 1000 };

/** 新着表示の日数として受け付ける範囲（0 = 表示しない）。 */
export const NEW_MODEL_DAYS_RANGE = { min: 0, max: 90 };
