/**
 * 会話画面に出すタイトル（ヘッダーと文書のタイトル）をどこから取るか。
 *
 * 会話画面のローダーは、同じ会話のままの取り直しでは走らせない
 * （chat.$id.tsx の shouldRevalidate）。本文を使うのは開いた瞬間だけで、
 * 以後は画面が自分で追いかけているのに、生成のたび・一覧の操作のたびに
 * 会話を丸ごとサーバーから引き直していたため。
 *
 * 取り直しで拾っていたもののうち、画面に効いていたのはタイトルだけ
 * だった（サイドバーでの名前の変更）。これはシェルの会話一覧から取る。
 * 一覧は操作のたびに取り直されるので、変更がそのまま届く。
 *
 * ただし**いつも一覧を正とはしない**。別の端末で名前を変えたとき、一覧が
 * それに気づくのは次の見張り（5秒ごと・画面が見えているときだけ。
 * 「一覧が動いた」番号で取り直す）で、それまでは古いまま残る。その間に
 * 会話を開くと、ローダーのほうが新しい名前を持っている。
 * 「後から届いたほうを正とする」——会話のデータを受け取った時点の一覧を
 * 控えておき、一覧がそれから取り直されていれば一覧を、そうでなければ
 * ローダーの値を使う。
 *
 * 「取り直されたか」はデータの同一性で見る。ローダーのデータは取り直す
 * まで同じ物のままなので、時刻を持ち回らなくても前後が分かる。先読みの
 * 写し（chat-cache）から返したデータも、写しの物そのものなので、写しを
 * 作った後に一覧が取り直されていれば一覧が勝つ。
 */

/**
 * シェルのルートID。`app/routes.ts` のモジュールパスから拡張子を除いたもの。
 *
 * 文字列で結ばれているので、ファイル名を変えると黙って外れる
 * （useRouteLoaderData は undefined を返すだけ）。外れるとサイドバーで
 * 名前を変えてもヘッダーが古いまま残る。`tests/chat-title-wiring.test.ts`
 * が routes.ts と突き合わせて見張る。
 */
export const SHELL_ROUTE_ID = "routes/shell";

/** タイトルを引くのに要るぶんだけのシェルのデータ。 */
export type ShellTitles =
  | { conversations?: { id: string; title: string }[] }
  | undefined;

/** 会話のデータを受け取ったときの、シェルのデータ。 */
const shellWhenLoaded = new WeakMap<object, ShellTitles>();

export function conversationTitle(
  chat: { conversation: { id: string; title: string } },
  shell: ShellTitles,
): string {
  // 初めて見たときの一覧を控える。以後の描画でも同じ物を見続ける限り
  // 「一覧はそれから取り直されていない」
  if (!shellWhenLoaded.has(chat)) shellWhenLoaded.set(chat, shell);
  if (shellWhenLoaded.get(chat) === shell) return chat.conversation.title;
  // 一覧の上限（200件）より古い会話は一覧に居ない。そのときはローダーの値
  return (
    shell?.conversations?.find((c) => c.id === chat.conversation.id)?.title ??
    chat.conversation.title
  );
}
