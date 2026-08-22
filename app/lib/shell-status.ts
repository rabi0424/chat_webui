/**
 * 画面の裏の取得が失敗したことを、利用者の言葉で伝える。
 *
 * 同じ「取れなかった」でも、影響の大きさが違う。モデル一覧が取れず
 * 手元にも無ければ何も送れないが、前回の一覧が残っていれば古いものを
 * 使って続けられる。為替は取れなくてもドル表示に戻るだけ。
 * どれも黙って済ませると、利用者は原因を探しようがない。
 */
export interface LoadFailures {
  /** モデル一覧の失敗理由。null = 失敗していない。 */
  models: string | null;
  /** 前回の一覧が手元にあるか（あれば古いまま使い続けられる）。 */
  hasCachedModels: boolean;
  /** 為替の失敗理由。null = 失敗していない。 */
  fx: string | null;
}

export function loadNotices(failures: LoadFailures): string[] {
  const notices: string[] = [];
  if (failures.models !== null) {
    notices.push(
      failures.hasCachedModels
        ? `モデル一覧を更新できませんでした（${failures.models}）。前回の一覧を表示しています。`
        : `モデル一覧を取得できませんでした（${failures.models}）。選べるモデルが無いため、送信もできません。`,
    );
  }
  if (failures.fx !== null) {
    notices.push(
      `為替レートを取得できませんでした（${failures.fx}）。金額はドルのまま表示します。`,
    );
  }
  return notices;
}
