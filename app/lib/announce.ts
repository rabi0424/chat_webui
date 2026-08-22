/**
 * 生成の進み具合を、読み上げに乗せる文言へ変換する。
 *
 * 画面には「点滅するカーソル」「エラーの帯」で出ているが、どちらも
 * 見えている人にしか届かない。読み上げでは「送信した」あと何も
 * 起きないまま数十秒が過ぎ、終わったことも失敗したことも分からない。
 *
 * 状態そのものではなく「変わり目」を文言にするのは、生成中ずっと
 * 同じ状態が続くため。毎レンダーで文言を作ると、同じ文が繰り返し
 * 領域へ書き戻される（読み上げが割り込みで詰まる）。
 */
export interface GenerationPhase {
  isStreaming: boolean;
  error: string | null;
}

/**
 * 直前と今の状態から、読み上げる文言を決める。無ければ null。
 *
 * 失敗したときは isStreaming が false へ落ちるのと error が入るのが
 * 同じ更新で起きる。「完了しました」と読み上げてから「エラー」と
 * 続けては意味が反転するので、エラーを先に見る。
 */
export function generationAnnouncement(
  prev: GenerationPhase,
  next: GenerationPhase,
): string | null {
  if (next.error !== null && next.error !== prev.error) {
    return `生成に失敗しました: ${next.error}`;
  }
  if (!prev.isStreaming && next.isStreaming) return "生成を開始しました";
  if (prev.isStreaming && !next.isStreaming) {
    // エラー付きで終わったぶんは上で読み上げ済み。
    return next.error === null ? "生成が完了しました" : null;
  }
  return null;
}
