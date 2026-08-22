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
  /**
   * 月間の上限額（円、JSTの暦月）。0 なら上限なし。
   * 超えると生成を止める（一時解除は monthlyLimitOverride）。
   */
  monthlyLimitJpy: number;
  /**
   * 上限を一時解除する月（"2026-08"）。null なら解除していない。
   *
   * 恒久のトグルにしないのは、解除したまま忘れるのが一番危ないため。
   * 月が変われば自動で効かなくなる。
   */
  monthlyLimitOverride: string | null;
  /**
   * Poe のポイント1点あたりのドル。0 なら見積もらない。
   *
   * Poe は応答に額を載せないので Usage API を照会するが、履歴への反映が
   * 間に合わないと取りこぼす。その分を上限の計算に混ぜるためのレート。
   */
  poePointsUsdRate: number;
  /**
   * 新規チャットで最初に選ぶモデル。null なら組み込みの既定。
   *
   * ここに置くのは、既定のモデルが課金に直結するため（高いモデルが
   * 既定のままだと、選び直す前の1通目で事故る）。テーマのような
   * 端末ごとの好みとは性質が違う。
   *
   * ただし**その端末で最後に使ったモデルのほうが優先される**。
   * 選び直したモデルが次のチャットでも続くのは、切り替えながら使う
   * 上で欠かせない挙動なので、そちらを崩さない。この値は「まだ何も
   * 選んでいない端末での出発点」として効く。
   */
  defaultModelId: string | null;
  /**
   * ボットを使わない新規チャットに入れるシステムプロンプト。
   * 空文字なら入れない。
   *
   * 会話を作るときに写し取る（ボットと同じ扱い）。あとで変えても
   * 既にある会話には遡らない——遡ると、同じ会話の続きなのに前提が
   * 入れ替わることになる。
   */
  defaultSystemPrompt: string;
  /**
   * ボットを使わない新規チャットの生成パラメータ。
   * 空なら指定しない（モデル本来の既定に任せる）。
   */
  defaultParams: Record<string, unknown>;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  retryAttemptCeiling: 100,
  newModelDays: 3,
  // 既定は上限なし。実際に使う額を見てから決められるよう、
  // こちらで勝手な数字を入れて生成を止めることはしない
  monthlyLimitJpy: 0,
  monthlyLimitOverride: null,
  poePointsUsdRate: 0,
  defaultModelId: null,
  defaultSystemPrompt: "",
  defaultParams: {},
};

/** システムプロンプトとして受け付ける長さ。 */
export const DEFAULT_SYSTEM_PROMPT_MAX = 8_000;

/** 天井として受け付ける範囲。 */
export const RETRY_CEILING_RANGE = { min: 1, max: 1000 };

/** 新着表示の日数として受け付ける範囲（0 = 表示しない）。 */
export const NEW_MODEL_DAYS_RANGE = { min: 0, max: 90 };

/** 月間上限として受け付ける範囲（0 = 上限なし）。 */
export const MONTHLY_LIMIT_RANGE = { min: 0, max: 1_000_000 };

/** ポイント換算レートとして受け付ける範囲（0 = 見積もらない）。 */
export const POE_RATE_RANGE = { min: 0, max: 1 };

/**
 * その会話に写し取るシステムプロンプト。無ければ null。
 *
 * ボットを選んで始めた会話はボットのものを、素の会話はアプリ既定を
 * 写す。**参照ではなく写し**にするのは、あとで既定やボットを変えても
 * 既にある会話の前提が入れ替わらないようにするため（同じ会話の続きな
 * のに指示が変わると、応答が変わった理由が分からなくなる）。
 *
 * 空文字は「入れない」。system の中身が空のメッセージを送ると、
 * 上流によっては 400 になる。
 */
export function conversationSystemPrompt(
  bot: { system_prompt: string } | null,
  settings: AppSettings,
): string | null {
  const prompt = bot ? bot.system_prompt : settings.defaultSystemPrompt;
  return prompt.trim() === "" ? null : prompt;
}
