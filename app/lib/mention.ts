/**
 * 入力欄の冒頭に書く「宛先」のメンション（`@ボット名`）。
 *
 * 会話の途中で「この1通だけ別のボットに聞きたい」ことがある。ボットを
 * 選び直すために新規チャットへ戻るのは、いま書いている文脈を捨てることに
 * なるので、入力欄の中で宛先を指定できるようにした。
 *
 * ここは解析だけを持つ（画面は Composer、送信の効かせ方は Chat）。
 * 名前の突き合わせは端末側でしかできない——ボット名は利用者が付けた
 * 自由文字列で、空白も記号も入る。区切り文字で切り出す方式にすると
 * 「My Bot」のような名前が拾えないため、**ボット名の側から前方一致で
 * 当てにいく**形にしてある。
 *
 * 読み方の規則（テストは tests/mention.test.ts）:
 *
 * 1. 冒頭が `@`（全角 `＠` も可）でなければ、メンションではない。
 * 2. `@` の後ろの**1行目がまるごとボット名の前方一致**なら、打っている
 *    最中とみなす。候補を出し、丸ごと一致していればその宛先を採用する。
 * 3. そうでなければ（＝すでに文章が続いている）、続く文字列がボット名で
 *    始まっていないかを見る。始まっていればその宛先を採用する
 *    （`@翻訳 これを訳して` の形）。
 * 4. どちらでもなければ宛先は決まらない。**後ろは触らず**、候補として
 *    全件を出す（利用者が選んだら `@名前 ` を冒頭に差し込む）。
 *
 * 3 で「名前の後ろが空白かどうか」は見ない。日本語には語の区切りが無く、
 * `@翻訳これを訳して` のような書き方を弾くと、宛先が急に効かなくなった
 * ように見えるため。効いているかどうかは色（Composer の色分け）で示す。
 */

/** 冒頭に使える記号。日本語入力では全角で出ることがある。 */
const MENTION_MARKS = ["@", "＠"];

/** 解析に要るのは名前だけ。呼ぶ側は BotRow をそのまま渡してよい。 */
export interface MentionBot {
  id: string;
  name: string;
}

export interface MentionState<B extends MentionBot = MentionBot> {
  /** 冒頭がメンションの形をしている（`@` で始まる）。 */
  present: boolean;
  /**
   * 宛先として採用したボット。名前が丸ごと一致したときだけ入る。
   * 同じ名前のボットが複数あるときは一覧の先頭（名前で書く以上、
   * 文字列からは区別できない）。
   */
  bot: B | null;
  /** 打ちかけの断片（`@` の直後で、ボット名の前方一致として読める分）。 */
  fragment: string;
  /**
   * 差し替える範囲の終わり。`text.slice(0, replaceEnd)` がメンション。
   * 宛先が決まらないときは `@` の1文字だけを指す（後ろは本文として残す）。
   */
  replaceEnd: number;
  /** 候補（fragment に前方一致するボット。fragment が空なら全件）。 */
  candidates: B[];
}

function absent<B extends MentionBot>(): MentionState<B> {
  return {
    present: false,
    bot: null,
    fragment: "",
    replaceEnd: 0,
    candidates: [],
  };
}

export function parseMention<B extends MentionBot>(
  text: string,
  bots: readonly B[],
): MentionState<B> {
  if (!MENTION_MARKS.includes(text[0] ?? "")) return absent<B>();

  // 名前の無いボットは宛先にできない（`@` だけで一致してしまう）
  const named = bots.filter((b) => b.name !== "");
  const rest = text.slice(1);
  // 改行をまたいで名前を探さない。ボット名は1行の入力欄で作るので、
  // 改行を含む名前は存在しない
  const head = rest.split("\n")[0];
  const headLower = head.toLowerCase();

  // 打っている最中: 1行目がまるごと名前の前方一致
  const typing = named.filter((b) =>
    b.name.toLowerCase().startsWith(headLower),
  );
  if (typing.length > 0) {
    const exact = typing.find((b) => b.name.toLowerCase() === headLower) ?? null;
    return {
      present: true,
      bot: exact,
      fragment: head,
      replaceEnd: 1 + head.length,
      candidates: typing,
    };
  }

  // すでに文章が続いている: 続く文字列が名前で始まっていれば宛先にする。
  // 「翻訳」と「翻訳（英語）」のように片方がもう片方の前方一致になって
  // いることがあるので、長いほうを採る
  // 大小文字を無視して比べるが、切り出す長さは**元の文字数**で数える
  // （小文字化で長さが変わる文字があるため、変換後の文字列で切ると
  // 1文字ずれる）
  const matched = named
    .filter(
      (b) => rest.slice(0, b.name.length).toLowerCase() === b.name.toLowerCase(),
    )
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (matched) {
    const prefix = matched.name.toLowerCase();
    return {
      present: true,
      bot: matched,
      fragment: matched.name,
      replaceEnd: 1 + matched.name.length,
      // 候補は「その名前で始まるもの」。より長い名前へ打ち足せる
      candidates: named.filter((b) => b.name.toLowerCase().startsWith(prefix)),
    };
  }

  // 名前として読めない。後ろは本文として残し、候補は全件出す
  return {
    present: true,
    bot: null,
    fragment: "",
    replaceEnd: 1,
    candidates: named,
  };
}

/**
 * 候補を選んだときの本文。
 *
 * メンションの直後には区切りを必ず1つ置く。すでに空白や改行が続いて
 * いればそれを使い（`@ボ` → 選択 → `@ボット 本文` のように二重の空白を
 * 作らない）、無ければ空白を足す。返す caret はその区切りの直後
 * ——選んだ直後に続きを打ち始められる位置。
 */
export function applyMention(
  text: string,
  state: MentionState,
  bot: MentionBot,
): { text: string; caret: number } {
  const mention = `@${bot.name}`;
  const rest = text.slice(state.replaceEnd);
  if (rest === "") return { text: `${mention} `, caret: mention.length + 1 };
  const separated = /^[ \t\n]/.test(rest) ? rest : ` ${rest}`;
  return { text: mention + separated, caret: mention.length + 1 };
}

/**
 * 本文からメンションを取り除く（宛先の「解除」）。
 * 直後の区切りも1つだけ一緒に落とす。
 */
export function stripMention(text: string, state: MentionState): string {
  if (!state.present) return text;
  return text.slice(state.replaceEnd).replace(/^[ \t]/, "");
}
