/**
 * 上流へ投げる共通部分。
 *
 * 窓口（OpenRouter・Poe・API易）ごとにURLと鍵は違うが、「ヘッダが返る
 * までだけを見張る」という一点はどこでも同じで、しかも素直に書くと
 * 壊れる（下記）。窓口を足すたびに書き写すと、写し損ねた窓口だけが
 * 生成の途中で切れる——画面には「応答が途中で終わりました」としか
 * 出ないので、写し間違いに気づく手立てが無い。
 */

/**
 * 上流が応答ヘッダを返すまでの猶予。
 *
 * これが無いと、接続だけ張って何も返さない上流に当たったとき、
 * 生成の実行（DOのアラーム）がそこで永久に止まる。
 */
export const UPSTREAM_CONNECT_TIMEOUT_MS = 60_000;

/**
 * ヘッダが返るまでだけを見張って投げる。
 *
 * 素直に `signal: AbortSignal.timeout(...)` と書きたくなるが、それだと
 * 壊れる。fetch へ渡した signal はヘッダを受け取っても外れず、返って
 * きた**本文のストリームにも効いたまま**になる。そのため生成がこの猶予を
 * 超えると、トークンが順調に流れている最中でも body が TimeoutError で
 * 切られ、利用者には「応答が途中で終わりました（The operation was
 * aborted due to timeout）」と見えていた。長考するモデルや長い応答は
 * 60秒を普通に超えるので、これは日常的に起きていた。
 *
 * 時計はヘッダが返った時点で止める。ヘッダ以降の無音は読み手側の
 * idle timeout（generation.server.ts の UPSTREAM_IDLE_TIMEOUT_MS）が
 * 拾うので、ここで見張り続ける必要はない。
 */
export async function fetchAwaitingHeaders(
  url: string,
  /**
   * body は文字列とは限らない（画像の編集は multipart で送る）。
   * FormData を渡すときは Content-Type を**自分で付けない**こと——
   * 境界文字列は fetch が決めるので、手で付けると本文と食い違って
   * 上流がパースに失敗する。
   */
  init: { method: string; headers: Record<string, string>; body: BodyInit },
  timeoutMs: number,
  /**
   * 外からの打ち切り（1本の締め切り・停止後の猶予切れ）。ヘッダを
   * 待っているあいだだけ効かせる。本文は読み手が同じ signal で切る
   */
  outer?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("上流が応答ヘッダを返しませんでした"));
  }, timeoutMs);
  const onOuter = () => controller.abort(outer?.reason);
  if (outer?.aborted) onOuter();
  outer?.addEventListener("abort", onOuter, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    // ヘッダが返った（または投げるのに失敗した）時点で見張りを解く。
    // 残したままだと、上の signal がそのまま本文を切りに来る
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
  }
}
