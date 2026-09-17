import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { installServer, renderChat, type ServerStub } from "./helpers/chat-harness";
import { FILE_CLOSE, FILE_OPEN } from "../../app/lib/paste";

/**
 * テキストファイルを落とす・選ぶ。
 *
 * 添付（R2）にはせず、貼り付け・リンクと同じ札に乗せて**本文として**
 * 送る。落とした瞬間と送る瞬間が離れているので、途中で結び付きが
 * 切れても画面では分からない——札は出ているのに本文には何も入って
 * いない、という形になる。**届く本文**で確かめる。
 */
// 画像の縮小は canvas に依る。jsdom では読み込みが終わらないので素通しする
vi.mock("../../app/lib/image", async (orig) => {
  const actual = await orig<typeof import("../../app/lib/image")>();
  return { ...actual, prepareImage: async (f: File) => f };
});
let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

const textFile = (name: string, body: string, type = "text/plain") =>
  new File([body], name, { type });

/** 会話の枠へファイルを落とす（画面のいちばん外側が受ける）。 */
function drop(files: File[]): void {
  const box = screen.getByRole("textbox");
  const root = box.closest("div.relative.h-full") ?? document.body;
  fireEvent.drop(root, { dataTransfer: { types: ["Files"], files } });
}

const sendButton = () => screen.getByLabelText("送信") as HTMLButtonElement;
const textbox = () => screen.getByRole("textbox") as HTMLTextAreaElement;

/** 送信して、サーバーへ届いた本文を返す。 */
async function sendAndRead(
  user: ReturnType<typeof renderChat>["user"],
): Promise<string> {
  await user.click(sendButton());
  await waitFor(() => expect(server.lastBody("/generate")).toBeTruthy());
  return (server.lastBody("/generate") as { userContent: string }).userContent;
}

describe("テキストファイルを落とす", () => {
  it("札になり、送ると中身が囲みで届く", async () => {
    const { user } = renderChat({});

    drop([textFile("notes.txt", "1行目\n2行目")]);
    await screen.findByText("notes.txt");
    expect(textbox().value).toBe("[ファイル #1: notes.txt]");

    const sent = await sendAndRead(user);
    expect(sent).toBe(`${FILE_OPEN}notes.txt\n1行目\n2行目\n${FILE_CLOSE}`);
    // 札のまま送られていない（結び付きが切れるとこうなる）
    expect(sent).not.toContain("[ファイル #1");
  });

  /*
   * `.html` はリンクの取り込みと同じ変換を通す。タグのまま渡すと、
   * トークンの大半が属性で埋まる（記事1本のHTMLは本文の10倍を超える）。
   */
  it("HTML は本文だけを取り出して渡す", async () => {
    const { user } = renderChat({});

    drop([
      textFile(
        "page.html",
        "<html><head><title>題</title><script>alert(1)</script></head>" +
          "<body><nav>メニュー</nav><p>ここが本文です。</p></body></html>",
        "text/html",
      ),
    ]);
    await screen.findByText("page.html");

    const sent = await sendAndRead(user);
    expect(sent).toContain("ここが本文です。");
    expect(sent).not.toContain("<p>");
    expect(sent).not.toContain("alert(1)");
    expect(sent).not.toContain("メニュー");
  });

  /*
   * 書いた文を消さない。落とすのは本文を書いている途中がほとんどで、
   * 打った字が消えると気づかないまま送ることになる。
   */
  it("入力欄に書いた文は残り、札はその後ろに入る", async () => {
    const { user } = renderChat({});
    await user.type(textbox(), "これ読んで ");

    drop([textFile("a.txt", "中身")]);
    await screen.findByText("a.txt");
    expect(textbox().value).toBe("これ読んで [ファイル #1: a.txt]");

    expect(await sendAndRead(user)).toBe(
      `これ読んで ${FILE_OPEN}a.txt\n中身\n${FILE_CLOSE}`,
    );
  });

  /*
   * **読んでいる最中に打った字を消さない。**
   *
   * 札を差し込むのはファイルを読み終えたあと（非同期）。そのとき
   * 閉包に捕まえた本文を書き戻すと、落とした瞬間の値まで巻き戻り、
   * そのあいだに打った字が消える——画面から消えるだけなので、
   * 打った本人が気づかないまま送ることになる。
   */
  it("読んでいる最中に打った字が消えない", async () => {
    renderChat({});

    drop([textFile("a.txt", "中身")]);
    // 読み終える前に打つ（fireEvent は同期なので、必ず読み取りより先）
    fireEvent.change(textbox(), { target: { value: "打った" } });

    await screen.findByText("a.txt");
    expect(textbox().value).toContain("打った");
    expect(textbox().value).toContain("[ファイル #1: a.txt]");
  });

  it("複数を一度に落とすと、通し番号で並ぶ", async () => {
    const { user } = renderChat({});

    drop([textFile("a.txt", "あ"), textFile("b.md", "い")]);
    await screen.findByText("b.md");
    expect(textbox().value).toBe("[ファイル #1: a.txt][ファイル #2: b.md]");

    const sent = await sendAndRead(user);
    expect(sent).toContain(`${FILE_OPEN}a.txt\nあ\n${FILE_CLOSE}`);
    expect(sent).toContain(`${FILE_OPEN}b.md\nい\n${FILE_CLOSE}`);
  });

  /*
   * 画像とテキストを混ぜて落としたときに、片方が黙って消えないこと。
   * 以前は画像だけを拾い、残りは何も言わずに落ちていた。
   */
  it("画像と混ぜて落としても、両方それぞれの扱いになる", async () => {
    server.on("/api/uploads", () => ({
      id: "att-1",
      size: 4,
      mimeType: "image/png",
    }));
    renderChat({});

    drop([
      new File([new Uint8Array([137, 80, 78, 71])], "a.png", {
        type: "image/png",
      }),
      textFile("b.txt", "中身"),
    ]);

    await screen.findByText("b.txt");
    expect(textbox().value).toBe("[ファイル #1: b.txt]");
    // 画像はこれまでどおり添付として上がる
    await waitFor(() => expect(server.countOf("/api/uploads")).toBe(1));
  });

  /*
   * 受け付けないものを落としたときは、そうと言う。黙って落ちると
   * 「添付したつもり」で送ることになる。
   */
  it("画像でもテキストでもないものは、受け付けないと出す", async () => {
    renderChat({});
    drop([new File([new Uint8Array([1, 2])], "a.zip", { type: "application/zip" })]);
    await screen.findByText("画像とテキストファイルだけ添付できます。");
  });

  /*
   * 中身を取り出せなかったファイルは札にしない。空の囲みを渡すと、
   * モデルは「中身の無いファイル」を読んだことにして答えてしまう。
   */
  it("空のファイルは札にせず、読み取れなかったと出す", async () => {
    renderChat({});
    drop([textFile("empty.txt", "   ")]);
    await screen.findByText(/中身を読み取れませんでした/);
    expect(textbox().value).toBe("");
  });

  /*
   * ファイル選択（クリップのボタン）でも同じ扱いになること。入口ごとに
   * 振り分けを書くと、「落とすと入るのに選ぶと弾かれる」が起きる。
   */
  it("ファイル選択から選んでも同じ", async () => {
    const { container, user } = renderChat({});
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    // 選択画面で灰色にならないこと（accept に載っているか）
    expect(input.accept).toContain(".txt");
    expect(input.accept).toContain(".html");

    fireEvent.change(input, { target: { files: [textFile("c.txt", "中身")] } });
    await screen.findByText("c.txt");

    expect(await sendAndRead(user)).toBe(
      `${FILE_OPEN}c.txt\n中身\n${FILE_CLOSE}`,
    );
  });
});
