import { MAX_UPLOAD_BYTES, providerOf } from "./constants";

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

/**
 * 1回の依頼に載せる PDF の合計（バイト。base64 にする前の大きさ）。
 *
 * PDF は画像と違って縮められず、1つが上限の 10MB まである。しかも履歴の
 * 添付は**毎ターン全部**送り直す。base64 にすると 4/3 倍になり、それを
 * 本文の JSON に組み込み、送るためにもう一度バイト列にする——10MB の
 * PDF 1つで、実行体のメモリ（128MB）のうち 50MB 前後が一時に埋まる。
 * PDF を何本も添えた会話をそのまま組むと、メモリを使い切って実行ごと
 * 落とされ、応答は「中断」で終わる。
 *
 * 上限は1ファイルの上限と同じにする（最大の PDF 1本はいつでも載る）。
 * 超えたぶんは**古い発言の PDF から**読まずに落とす。今の発言で添えた
 * PDF がいちばん読まれるべきもので、古いものはたいてい既に答えの中で
 * 使われている。
 */
export const PDF_BUDGET_BYTES = MAX_UPLOAD_BYTES;

/**
 * 上限の内に載せる PDF を選ぶ。
 *
 * groups は発言ごとの PDF（古い発言から順、発言の中は添付の順）。
 * **新しい発言から**数え、入らないものは飛ばす（打ち切らない——大きい
 * 1つより古い小さい PDF まで落とさないため）。同じ PDF を2つの発言が
 * 指していても、実体は1度しか載らないので1度だけ数える。
 *
 * 上流へ組み立てる側（expandAttachments）と、入力欄の OCR の見積もりが
 * 同じものを使う。ここに置くのは、クライアントからも読めるため
 * （generation.server はサーバー専用）。
 */
export function pickPdfsWithinBudget(
  groups: { id: string; size: number }[][],
  budget: number,
): Set<string> {
  const picked = new Set<string>();
  let room = budget;
  for (let i = groups.length - 1; i >= 0; i--) {
    for (const { id, size } of groups[i]) {
      if (picked.has(id) || size > room) continue;
      room -= size;
      picked.add(id);
    }
  }
  return picked;
}
