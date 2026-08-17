import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./Markdown";

/**
 * 生成中の応答の表示。
 *
 * サーバーからの本文は数百msおきのポーリングでまとめて届くため、
 * そのまま描くと文章が塊で「ぶつっ」と現れる。ここでは
 *
 *  1. 届いた本文を少しずつ切り出して（useRevealedText）
 *  2. 流入中の末尾だけを細かく描き直し（splitStream）
 *  3. 新しく現れた語だけをふわりと浮かび上がらせる（Markdown の animate）
 *
 * という3段で、届き方に関係なく一定の速さで滑らかに流れて見せる。
 */

/**
 * 表示を進める最短間隔（ms）。毎フレーム描き直すのは重いので間引く。
 * 1回の描き直しは末尾だけなので軽いが、それでも安い端末では効いてくる。
 * 語ごとのフェード（0.3秒）が間を埋めるので、これでも途切れて見えない。
 */
const COMMIT_MS = 70;
/** 未表示分を吐き切る目安の時間（ms）。短いほど速く、長いほど滑らか。 */
const CATCH_UP_MS = 600;
/** 生成が終わったあとの追いつき時間（ms）。 */
const FINISH_MS = 220;
/** これ以上遅れたら一気に詰める（文字数）。 */
const MAX_LAG = 320;
/** 「流入中の末尾」として細かく描き直す上限（文字数）。 */
const TAIL_MAX = 400;

/**
 * 本文を「確定した前半」と「流入中の末尾」に分ける。
 *
 * 末尾だけを毎回描き直せば、長い応答でもマークダウンの解析コストは
 * 一定に保てる。切れ目は段落 → 行 の順に探し、コードブロックや
 * ブロック数式の途中では切らない（前半だけが壊れて見えるため）。
 */
function splitStream(text: string): {
  head: string;
  /** null = 分割できない（全体をそのまま描く）。 */
  tail: string | null;
  /** 行の途中で切った = 段落の間隔を空けない。 */
  tight: boolean;
} {
  const whole = { head: text, tail: null, tight: false };
  if (!text) return whole;
  // 閉じていないコードフェンスの内側は切らない
  const fences = text.match(/^ {0,3}(?:`{3,}|~{3,})/gm)?.length ?? 0;
  if (fences % 2 === 1) return whole;

  const at = (cut: number, keep: number, tight: boolean) => {
    const head = text.slice(0, cut + keep);
    const tail = text.slice(cut + keep);
    if (!tail.trim() || tail.length > TAIL_MAX) return null;
    // ブロック数式（$$）を跨いで切ると前半が数式のまま閉じない
    if ((head.match(/\$\$/g)?.length ?? 0) % 2 === 1) return null;
    return { head, tail, tight };
  };

  const para = text.lastIndexOf("\n\n");
  if (para >= 0) {
    const split = at(para, 2, false);
    if (split) return split;
  }
  const line = text.lastIndexOf("\n");
  if (line >= 0) {
    const split = at(line, 1, true);
    if (split) return split;
  }
  // 改行がまだ来ていない短い応答は、全体を流入中として扱う
  if (text.length <= TAIL_MAX) return { head: "", tail: text, tight: false };
  return whole;
}

/**
 * 目標の本文へ一定の速さで追いつく、表示済みの先頭部分を返す。
 * マウント時点の内容は（別端末で進んだ会話を開いた場合など）そのまま出す。
 */
function useRevealedText(
  text: string,
  streaming: boolean,
  commitMs: number,
): string {
  const [count, setCount] = useState(text.length);
  const countRef = useRef(count);
  const latest = useRef({ text, streaming, commitMs });
  latest.current = { text, streaming, commitMs };

  // 分岐の切り替えや再生成で内容が短くなったら合わせ直す
  if (countRef.current > text.length) countRef.current = text.length;

  useEffect(() => {
    if (countRef.current >= text.length) return;
    let raf = 0;
    let last = performance.now();
    let committed = last;
    const tick = (now: number) => {
      const cur = latest.current;
      const remaining = cur.text.length - countRef.current;
      if (remaining <= 0) {
        raf = 0;
        return;
      }
      const dt = Math.min(now - last, 120);
      last = now;
      const span = cur.streaming ? CATCH_UP_MS : FINISH_MS;
      let step = Math.max(1, Math.ceil((remaining / span) * dt));
      // 遅れが大きいとき（タブ復帰・巨大なチャンク）は一気に詰める
      if (remaining - step > MAX_LAG) step = remaining - MAX_LAG;
      countRef.current = Math.min(cur.text.length, countRef.current + step);
      if (now - committed >= cur.commitMs || countRef.current >= cur.text.length) {
        committed = now;
        setCount(countRef.current);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, streaming]);

  // サロゲートペア（絵文字など）の途中で切らない
  let end = Math.min(count, text.length);
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return end >= text.length ? text : text.slice(0, end);
}

export function StreamingMessage({
  text,
  streaming,
  onReveal,
}: {
  text: string;
  /** サーバー側でまだ生成中か。終わったら残りを早めに出し切る。 */
  streaming: boolean;
  /** 表示が伸びるたびに呼ぶ（最下部への追従に使う）。 */
  onReveal?: () => void;
}) {
  // 末尾を切り出せないとき（長いコードブロックなど）は全体を描き直すことに
  // なるので、本文の長さに応じて描き直しの間隔を広げる
  const target = useMemo(() => splitStream(text), [text]);
  const commitMs =
    target.tail == null
      ? Math.min(160, Math.max(COMMIT_MS, Math.round(text.length / 12)))
      : COMMIT_MS;

  const revealed = useRevealedText(text, streaming, commitMs);
  const shown = useMemo(() => splitStream(revealed), [revealed]);

  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  useLayoutEffect(() => {
    reveal.current?.();
  }, [revealed]);

  // 追いつき終わったら、ふつうのメッセージと同じ描き方に戻す
  if (!streaming && revealed.length >= text.length) {
    return <Markdown>{text}</Markdown>;
  }

  return (
    <>
      {shown.head && <Markdown>{shown.head}</Markdown>}
      {shown.tail && (
        <Markdown
          animate
          className={shown.head ? (shown.tight ? "mt-0" : "mt-4") : undefined}
        >
          {shown.tail}
        </Markdown>
      )}
    </>
  );
}
