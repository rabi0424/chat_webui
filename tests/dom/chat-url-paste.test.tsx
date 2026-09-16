import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Markdown } from "../../app/components/Markdown";
import { installServer, renderChat, type ServerStub } from "./helpers/chat-harness";
import { PAGE_CLOSE, PAGE_OPEN } from "../../app/lib/paste";

/**
 * 入力欄に貼られたリンクの取り込み。
 *
 * 取り込みは「貼った瞬間」と「送る瞬間」が離れていて、そのあいだに
 * 通信が挟まる。結び付きが切れたときの出方は**画面では分からない**
 * ——札は出ているのに本文にはリンクしか入っていない、あるいは読み
 * 終える前に送れてしまう。届く本文で確かめる。
 */
let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

const LINK = "https://example.com/a";

/** ページの応答（本物のルートと同じ形）。 */
function servePage(body: string, url = LINK) {
  server.on("/api/page", () => ({ url, contentType: "text/html", body }));
}

function paste(text: string): HTMLTextAreaElement {
  const box = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.paste(box, { clipboardData: { getData: () => text, files: [] } });
  return box;
}

const sendButton = () => screen.getByLabelText("送信") as HTMLButtonElement;

describe("リンクを貼る", () => {
  it("札に畳まれ、送ると本文がページの囲みで届く", async () => {
    servePage("<h1>記事の題</h1><p>ここが本文です。</p>");
    const { user } = renderChat({});

    const box = paste(LINK);
    expect(box.value).toBe("[ページ #1: example.com]");
    // 取りに行くのはサーバー経由（ブラウザからは他所を読めない）
    await waitFor(() => expect(server.countOf("/api/page")).toBe(1));
    expect(server.lastBody("/api/page")).toEqual({ url: LINK });
    await screen.findByText(/行・/);

    await user.click(sendButton());
    await waitFor(() => expect(server.lastBody("/generate")).toBeTruthy());
    const { userContent } = server.lastBody("/generate") as {
      userContent: string;
    };
    expect(userContent).toContain(`${PAGE_OPEN}記事の題 — ${LINK}`);
    expect(userContent).toContain("ここが本文です。");
    expect(userContent).toContain(PAGE_CLOSE);
    // 札のまま送られていない
    expect(userContent).not.toContain("[ページ #1");
  });

  it("読み終えるまでは送れない", async () => {
    server.on("/api/page", () => new Promise<never>(() => {}));
    renderChat({});

    paste(LINK);
    await screen.findByText("読み込み中…");
    await waitFor(() => expect(sendButton().disabled).toBe(true));
    expect(sendButton().title).toBe("ページを読み込み中…");
  });

  /**
   * 送信ボタンを止めるだけでは足りない。Enter は入力欄から直に
   * 送信を呼ぶので、ボタンが灰色でも通ってしまう——通ると、本文に
   * リンクだけが入った1通が送られる（取り込みは捨てられる）。
   */
  it("読み終えるまでは Enter でも送れない", async () => {
    server.on("/api/page", () => new Promise<never>(() => {}));
    const { user } = renderChat({});

    const box = paste(LINK);
    await screen.findByText("読み込み中…");
    box.focus();
    await user.keyboard("{Enter}");

    expect(server.countOf("/generate")).toBe(0);
    expect(box.value).toBe("[ページ #1: example.com]");
  });

  it("取り込めなければ理由を出し、リンクのまま送れる", async () => {
    server.on(
      "/api/page",
      () =>
        new Response(JSON.stringify({ error: "このリンクは取り込めません（内側のアドレス）" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { user } = renderChat({});

    paste(LINK);
    await screen.findByText(/内側のアドレス/);
    expect(sendButton().disabled).toBe(false);

    await user.click(sendButton());
    await waitFor(() => expect(server.lastBody("/generate")).toBeTruthy());
    const { userContent } = server.lastBody("/generate") as {
      userContent: string;
    };
    expect(userContent).toBe(LINK);
    expect(userContent).not.toContain(PAGE_OPEN);
  });

  it("失敗したあと「再取得」で取り直せる", async () => {
    let attempts = 0;
    server.on("/api/page", () => {
      if (++attempts === 1) {
        return new Response(JSON.stringify({ error: "取れませんでした" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      return {
        url: LINK,
        contentType: "text/html",
        body: "<p>二度目は読めた本文です。</p>",
      };
    });
    const { user } = renderChat({});

    paste(LINK);
    await screen.findByRole("button", { name: "ページ #1 を再取得" });

    await user.click(screen.getByRole("button", { name: "ページ #1 を再取得" }));
    await screen.findByText(/行・/);

    await user.click(sendButton());
    await waitFor(() => expect(server.lastBody("/generate")).toBeTruthy());
    expect(
      (server.lastBody("/generate") as { userContent: string }).userContent,
    ).toContain("二度目は読めた本文です。");
  });

  it("× で取り込みをやめると、リンクの文字が残る", async () => {
    servePage("<p>ここが本文です。</p>");
    const { user } = renderChat({});

    const box = paste(LINK);
    await screen.findByText(/行・/);
    await user.click(
      screen.getByRole("button", { name: "ページ #1 の取り込みをやめる" }),
    );
    expect(box.value).toBe(LINK);
    expect(screen.queryByText(/行・/)).toBeNull();
    // 札の一覧から消えても、入力欄そのものは生きている
    expect(sendButton().disabled).toBe(false);
  });

  it("文章に混ざったリンクには触らない", async () => {
    servePage("<p>本文</p>");
    renderChat({});

    const box = paste(`これ読んで ${LINK}`);
    // preventDefault していないので jsdom では何も入らないが、札も出ない
    expect(box.value).toBe("");
    expect(server.countOf("/api/page")).toBe(0);
    expect(screen.queryByText(/行・/)).toBeNull();
  });

  it("2本目のリンクは別の札になる", async () => {
    servePage("<p>ここが本文です。</p>");
    const { user } = renderChat({});

    const box = paste(LINK);
    await screen.findByText(/行・/);
    servePage("<p>ふたつめの本文です。</p>", "https://other.example/b");
    fireEvent.paste(box, {
      clipboardData: { getData: () => "https://other.example/b", files: [] },
    });
    await waitFor(() =>
      expect(box.value).toBe(
        "[ページ #1: example.com][ページ #2: other.example]",
      ),
    );
    await waitFor(() => expect(screen.getAllByText(/行・/)).toHaveLength(2));

    await user.click(sendButton());
    await waitFor(() => expect(server.lastBody("/generate")).toBeTruthy());
    const { userContent } = server.lastBody("/generate") as {
      userContent: string;
    };
    expect(userContent).toContain("ここが本文です。");
    expect(userContent).toContain("ふたつめの本文です。");
  });

  /**
   * 囲みと、本文の描き方の結び付き（画面にエラーの出ない壊れ方）。
   *
   * 送った本文は自分の発言としてマークダウンで描かれる。囲みをタグ
   * （`<page …>`）にすると、消毒が知らない要素として落とすので、
   * **中身だけが残って囲みが消える**——どこからが取り込んだ文章
   * なのか、後から読んで分からなくなる。落ちていないことを、実際に
   * 描いた結果で見る。
   */
  it("囲みは、描いたあとの画面にも残る", () => {
    const { container } = render(
      <Markdown>{`${PAGE_OPEN}記事の題 — ${LINK}\n本文です\n${PAGE_CLOSE}`}</Markdown>,
    );
    expect(container.textContent).toContain(PAGE_OPEN);
    expect(container.textContent).toContain(PAGE_CLOSE);
    expect(container.textContent).toContain("本文です");
  });

  /**
   * 読み込み中のまま画面が作り直されると、取りに行っていた処理ごと
   * 失われる。待ち続ける札が残ると、送信も止まったままになる。
   */
  it("読み込み中のまま下書きに残った札は、再取得できる形で戻る", async () => {
    // 下書きは会話ごとに持つ（この足場の会話IDは conv-1）
    localStorage.setItem("chat-webui:draft:conv-1", "[ページ #1: example.com]");
    localStorage.setItem(
      "chat-webui:draft-pastes:conv-1",
      JSON.stringify([{ n: 1, text: "", url: LINK, status: "loading" }]),
    );
    renderChat({});

    await screen.findByText("読み込みが中断されました");
    expect(sendButton().disabled).toBe(false);
    expect(
      screen.getByRole("button", { name: "ページ #1 を再取得" }),
    ).toBeTruthy();
  });
});
