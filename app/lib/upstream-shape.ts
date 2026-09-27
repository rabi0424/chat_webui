import { providerOf } from "./constants";

/**
 * 上流が「直近のユーザー発言の画像だけ」を使う窓口か。
 *
 * 画像だけの窓口（Runware、API易の画像モデル）は会話を受け取らず、
 * 依頼文1本と参照画像しか送れない（generation.server.ts の imageRequestOf）。
 * そこへ履歴の画像まで R2 から読んで base64 にしても、組み立ての段で
 * 捨てるだけで、上流へ投げるまでの時間と内部のサブリクエストを使う。
 *
 * requestUpstream の振り分けと**同じ条件**でなければならない。こちらだけ
 * 広げると、会話を送る窓口に履歴の画像が黙って届かなくなる。結び付きは
 * tests/server/expand-attachments.test.ts が見張っている。
 *
 * generation.server.ts に置かないのは、リトライ生成の1本担当
 * （retry-run.server.ts）も使い、そちらのテストが generation.server を
 * 丸ごと差し替えているため。
 */
export function usesLatestUserImagesOnly(job: {
  model: string;
  imageOutput?: boolean;
}): boolean {
  const provider = providerOf(job.model);
  if (provider === "runware") return true;
  return provider === "apiyi" && !!job.imageOutput;
}
