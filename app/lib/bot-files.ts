/**
 * ボットに添付するファイル（参照用の資料）。
 *
 * **中身はテキストとして持ち、システムプロンプトの後ろに付けて渡す。**
 * 入力欄のテキストファイルと同じ理由で、添付（R2）にはしない——添付の
 * 器は画像専用で、OpenAI 互換の補完に「テキストファイル」という渡し方が
 * 無い（`lib/text-file.ts` の頭）。囲みの印も入力欄のファイルと同じもの
 * を使う（`fileEnvelope`）。印を均す規則を2か所に書くと、片方の印を
 * 書いておくだけで囲みの外へ抜けられるようになる。
 *
 * 足すのはサーバー（生成の入口）。画面はファイルの中身を持たない——
 * シェルは全ページの土台で、ボットの一覧はそこに載る。1本 4万字の
 * ファイルを何本も載せると、どの画面を開いてもその全文が HTML に乗る。
 */

// 型だけ。画面（BotForm）もこのファイルを読むので、値は読まない
import type { ChatMessage } from "./openrouter.server";
import { fileEnvelope } from "./paste";

export interface BotFile {
  name: string;
  /** 取り出した本文（`.html` はリンクの取り込みと同じ変換を通したあと）。 */
  content: string;
  /** 大きさの上限で切ったか。 */
  truncated?: boolean;
}

/** 1つのボットに付けられるファイルの数。 */
export const BOT_FILES_MAX = 10;

/**
 * 1つのボットに付けられる字数の合計。
 *
 * ファイルは**毎回の送信で**モデルへ渡る（そのぶん入力の額がかかる）。
 * それに D1 の1行は 2MB まで——ボットの行と、会話に写した行の両方が
 * これを抱える。日本語は1字3バイトなので、20万字でおよそ 600KB に収まる。
 * 1本の上限（設定画面の「リンクの取り込み」の字数）の天井と同じ値。
 */
export const BOT_FILES_TOTAL_CHARS = 200_000;

/** ファイル名の長さ（それ以上は切る）。 */
const NAME_MAX = 200;

/** 保存してある JSON を読む。壊れていたら無いものとして扱う。 */
export function parseBotFiles(json: string | null | undefined): BotFile[] {
  if (!json) return [];
  try {
    return sanitizeBotFiles(JSON.parse(json));
  } catch {
    return [];
  }
}

/**
 * 送られてきた値を、保存してよい形に絞る。
 *
 * 画面の側でも上限を見ているが、API は信用しない。上限を超えたぶんは
 * **途中で切らずにそのファイルごと落とす**——黙って切ると、モデルは
 * 「そこで終わっている資料」として読む。中身の無いものも落とす
 * （空の囲みを渡すと、モデルは中身の無いファイルを読んだことにする）。
 */
export function sanitizeBotFiles(input: unknown): BotFile[] {
  if (!Array.isArray(input)) return [];
  const out: BotFile[] = [];
  let total = 0;
  for (const item of input) {
    if (out.length >= BOT_FILES_MAX) break;
    if (typeof item !== "object" || item === null) continue;
    const { name, content, truncated } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof content !== "string") continue;
    if (content.trim() === "") continue;
    if (total + content.length > BOT_FILES_TOTAL_CHARS) continue;
    total += content.length;
    out.push({
      name: name.trim().slice(0, NAME_MAX) || "無題",
      content,
      ...(truncated === true ? { truncated: true } : {}),
    });
  }
  return out;
}

/** 保存する値。無ければ NULL（空の配列を書かない）。 */
export function botFilesJson(files: BotFile[]): string | null {
  return files.length > 0 ? JSON.stringify(files) : null;
}

export function totalChars(files: BotFile[]): number {
  return files.reduce((n, f) => n + f.content.length, 0);
}

/**
 * 画面で足すとき。同じ名前のファイルは**置き換える**（手元で直した版を
 * 選び直したとき、古い版と新しい版が両方渡るのを避ける）。
 *
 * 数・字数の上限を超えるものは足さずに返す（呼ぶ側が知らせる）。
 */
export function addBotFiles(
  current: BotFile[],
  incoming: BotFile[],
): { files: BotFile[]; rejected: string[] } {
  let files = [...current];
  const rejected: string[] = [];
  for (const file of incoming) {
    const rest = files.filter((f) => f.name !== file.name);
    if (
      rest.length >= BOT_FILES_MAX ||
      totalChars(rest) + file.content.length > BOT_FILES_TOTAL_CHARS
    ) {
      rejected.push(file.name);
      continue;
    }
    const at = files.findIndex((f) => f.name === file.name);
    files =
      at >= 0
        ? files.map((f, i) => (i === at ? file : f))
        : [...files, file];
  }
  return { files, rejected };
}

/** システムプロンプトの後ろに付ける文。 */
export function botFilesBlock(files: BotFile[]): string {
  return [
    "以下はこのボットに添付されたファイルです。参照用の資料として使ってください。",
    ...files.map((f) => fileEnvelope(f.name, f.content)),
  ].join("\n\n");
}

/**
 * 送るメッセージ列にファイルを足す。
 *
 * system があればその後ろへ、無ければ先頭に system を立てる。画面は
 * プロンプトが空のとき system を送らない（空の system は上流によって
 * 400 になる）ので、「プロンプトは空でファイルだけ」のボットはこちら。
 */
export function withBotFiles(
  messages: ChatMessage[],
  files: BotFile[],
): ChatMessage[] {
  if (files.length === 0) return messages;
  const block = botFilesBlock(files);
  const at = messages.findIndex((m) => m.role === "system");
  if (at < 0) return [{ role: "system", content: block }, ...messages];
  return messages.map((m, i) =>
    i === at ? { ...m, content: `${m.content}\n\n${block}` } : m,
  );
}

/**
 * 生成の入口で、どのボットのファイルを足すかを画面が申告する形。
 *
 * 画面はシステムプロンプトを自分で組み立てて送ってくる（`Chat.tsx`）。
 * ファイルはその**同じボット**のものでなければならないので、どのボットの
 * プロンプトを入れたかを一緒に言ってもらう。
 */
export interface BotFilesRequest {
  botId: string;
  /**
   * 会話の担当ボットとして送ったか（宛先メンションではなく）。
   * 担当なら会話に写したファイル、宛先ならボットのいまのファイルを使う
   * ——プロンプトの側もそう選ばれている（担当は会話の写し、宛先は
   * ボットのいまの定義）。
   */
  fromConversation: boolean;
}

export function readBotFilesRequest(value: unknown): BotFilesRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const { botId, fromConversation } = value as Record<string, unknown>;
  if (typeof botId !== "string" || botId === "") return null;
  return { botId, fromConversation: fromConversation === true };
}

/**
 * 足すファイルを決める。
 *
 * 会話の写しを使うのは、担当として送られ、**しかも会話の担当がその
 * ボットのまま**のときだけ。担当を切り替えた直後は、切り替えの書き込み
 * （PATCH）より先に送信が届くことがある——そのとき会話の写しはまだ前の
 * ボットのもので、新しいボットのプロンプトに前のボットの資料が付いて
 * しまう。食い違ったら、切り替えが写すのと同じ「ボットのいまの定義」を使う。
 *
 * `current` はボットのいまの files_json。ボットが消えていれば undefined。
 */
export function botFilesForGeneration(
  request: BotFilesRequest | null,
  conversation: { bot_id: string | null; bot_files_json: string | null },
  current: string | null | undefined,
): BotFile[] {
  if (!request) return [];
  if (request.fromConversation && conversation.bot_id === request.botId) {
    return parseBotFiles(conversation.bot_files_json);
  }
  return parseBotFiles(current);
}
