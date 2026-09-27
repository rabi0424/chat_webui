import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MarkdownBody, proseClassName } from "./Markdown";
import { splitBlocks } from "../lib/markdown-blocks";
import { prepareMarkdown } from "../lib/markdown";

/**
 * 生成中の応答の表示。
 *
 * サーバーからの本文は数百msおきのポーリングでまとめて届くため、
 * そのまま描くと文章が塊で「ぶつっ」と現れる。ここでは
 *
 *  1. 届いた本文を少しずつ切り出して（useRevealedText）
 *  2. 塊に分け、伸びている末尾の塊だけを描き直し（splitBlocks + memo。
 *     分けるのはこの画面で流れてきた応答だけ——下の blockMode）
 *  3. 新しく現れた語だけをふわりと浮かび上がらせる（animate）
 *
 * という3段で、届き方に関係なく一定の速さで滑らかに流れて見せる。
 *
 * 生成中と生成後で描き方を変えない。切り替えると React がそこを作り
 * 直し、出来上がった図や並べ替えた表が元に戻る（監査 E-7）。
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
 * 切れ目は段落 → 行 の順に探し、コードブロックやブロック数式の途中では
 * 切らない（前半だけが壊れて見えるため）。
 *
 * いまの用途は**切れ目を見つけられるかどうかの判定**だけ。描画は塊
 * （splitBlocks）に任せているが、長いコードブロックのように切れ目の
 * 無い本文は塊にも分かれず、伸びるたび全体を解析し直すことになる。
 * その見分けにここを使い、描き直しの間隔を広げる。
 */
export function splitStream(text: string): {
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
    // ブロック数式を跨いで切ると、前半が数式のまま閉じない。
    // $$…$$ だけでなく \[…\] の書き方もあるので、両方を見る
    // （こちらは開きと閉じが別の記号なので、数を突き合わせる）
    if ((head.match(/\$\$/g)?.length ?? 0) % 2 === 1) return null;
    const opens = head.match(/\\\[/g)?.length ?? 0;
    const closes = head.match(/\\\]/g)?.length ?? 0;
    if (opens !== closes) return null;
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
  onImageClick,
}: {
  text: string;
  /** サーバー側でまだ生成中か。終わったら残りを早めに出し切る。 */
  streaming: boolean;
  /** 表示が伸びるたびに呼ぶ（最下部への追従に使う）。 */
  onReveal?: () => void;
  /** 本文の中の画像をタップしたとき（拡大表示を開く）。 */
  onImageClick?: (src: string) => void;
}) {
  // 切れ目が見つからないとき（長いコードブロックなど）は塊にも分かれず、
  // 伸びるたび全体を描き直すことになるので、長さに応じて間隔を広げる
  const target = useMemo(() => splitStream(text), [text]);
  const commitMs =
    target.tail == null
      ? Math.min(160, Math.max(COMMIT_MS, Math.round(text.length / 12)))
      : COMMIT_MS;

  const revealed = useRevealedText(text, streaming, commitMs);

  /** 追いつき終わったか。ここから先は「ふつうのメッセージ」と同じ中身。 */
  const done = !streaming && revealed.length >= text.length;

  /**
   * 表示ぶんを塊に分けて描く。塊ごとに memo が効くので、伸びている
   * 末尾の塊だけが解析し直され、すでに出ている塊はそのまま残る
   * （長い応答ほど効く）。分ける前に一度だけ前処理するのは、画像URLの
   * 重複除去のように本文全体を見ないと判断できないものがあるため。
   *
   * **描き方を途中で切り替えない**。以前は「確定ぶん」と「流入中の末尾」を
   * 別の入れ物で描き、生成が終わったところで全文をひとつの Markdown に
   * 差し替えていた。要素の並びが変わると React はそこを作り直すので、
   * 出来上がっていた図は fallback に戻り、利用者が並べ替えた表は元の順に
   * 戻っていた（監査 E-7）。末尾も同じ入れ物の中の塊として置けば、
   * 生成が終わっても並びは変わらず、中身が伸びるだけになる。
   */
  /*
   * ただし塊に分けるのは、**この画面で流れてきた**応答だけ。分けて得を
   * するのは伸びている間だけで、確定済みの応答を分けても解析し直す
   * ものは無い。一方で塊ごとに ReactMarkdown が解析の道具を組み直す
   * ので、分けるほど重くなる（2.6KB の応答が 81 塊に分かれ、1つで描く
   * ときの約3.6倍かかっていた）。会話を開いたときに並ぶのはほとんどが
   * 確定済みなので、そこは1つの Markdown として描く。
   *
   * 「いま生成中か」ではなく「生成中だったことがあるか」で決める。
   * 終わったところで1つに切り替えると、上に書いた作り直し（E-7）が
   * そのまま起きる。一度でも流れてきたら、この画面にある間は塊のまま。
   * 逆向き（確定済み → 生成中）はここで切り替えるが、そのときは本文が
   * 書き直されるところなので、残しておくべき図や表の状態が無い。
   */
  const [blockMode, setBlockMode] = useState(streaming);
  if (streaming && !blockMode) setBlockMode(true);

  const blocks = useMemo(
    () => (blockMode && revealed ? splitBlocks(prepareMarkdown(revealed)) : []),
    [revealed, blockMode],
  );

  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  useLayoutEffect(() => {
    reveal.current?.();
  }, [revealed]);

  /*
   * 塊の中で伸びているのは最後のひとつだけ。そこにだけ、新しく現れた語を
   * ふわりと出す指定を付ける。閉じていないコードフェンスがあると塊に
   * 分けられず全体がひとつになるが、その場合も「最後のひとつ」で当たる。
   */
  return (
    <div className={proseClassName()}>
      {blockMode
        ? blocks.map((block, i) => (
            <MarkdownBody
              key={i}
              prepared
              streaming={!done}
              animate={!done && i === blocks.length - 1}
              onImageClick={onImageClick}
            >
              {block}
            </MarkdownBody>
          ))
        : revealed && (
            <MarkdownBody streaming={!done} onImageClick={onImageClick}>
              {revealed}
            </MarkdownBody>
          )}
    </div>
  );
}
