import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Markdown } from "../../app/components/Markdown";
import { installServer, renderChat, type ServerStub } from "./helpers/chat-harness";
import { PAGE_CLOSE, PAGE_OPEN } from "../../app/lib/paste";
import { TRUNCATED_MARK } from "../../app/lib/page-limits";
import { DEFAULT_APP_SETTINGS } from "../../app/lib/settings";

/** 既定の上限（設定の `pageMaxChars`）。 */
const MAX_PAGE_TEXT_CHARS = DEFAULT_APP_SETTINGS.pageMaxChars;

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

  it("文章に混ざっていても、リンクのところだけが札になる", async () => {
    servePage("<h1>記事の題</h1><p>ここが本文です。</p>");
    const { user } = renderChat({});

    const box = paste(`これ読んで ${LINK} どう思う?`);
    expect(box.value).toBe("これ読んで [ページ #1: example.com] どう思う?");
    await screen.findByText(/行・/);

    await user.click(sendButton());
    await waitFor(() => expect(server.lastBody("/generate")).toBeTruthy());
    const { userContent } = server.lastBody("/generate") as {
      userContent: string;
    };
    // 書いた文はそのまま残り、リンクのところだけがページに変わる
    expect(userContent).toContain("これ読んで ");
    expect(userContent).toContain("どう思う?");
    expect(userContent).toContain(`${PAGE_OPEN}記事の題 — ${LINK}`);
    expect(userContent).toContain("ここが本文です。");
  });

  it("リンクの無い文には触らない", async () => {
    renderChat({});

    const box = paste("ただの文です。リンクはありません。");
    // preventDefault していないので jsdom では何も入らないが、札も出ない
    expect(box.value).toBe("");
    expect(server.countOf("/api/page")).toBe(0);
    expect(screen.queryByText(/行・/)).toBeNull();
  });

  it("1回の貼り付けに何本あっても、それぞれ札になる", async () => {
    let n = 0;
    server.on("/api/page", (body) => ({
      url: (body as { url: string }).url,
      contentType: "text/html",
      body: `<p>${++n}本目の本文です。</p>`,
    }));
    const { user } = renderChat({});

    const box = paste(`朝は${LINK}、夜は https://other.example/b を読んだ`);
    expect(box.value).toBe(
      "朝は[ページ #1: example.com]、夜は [ページ #2: other.example] を読んだ",
    );
    await waitFor(() => expect(screen.getAllByText(/行・/)).toHaveLength(2));

    await user.click(sendButton());
    await waitFor(() => expect(server.lastBody("/generate")).toBeTruthy());
    const { userContent } = server.lastBody("/generate") as {
      userContent: string;
    };
    expect(userContent).toContain("1本目の本文です。");
    expect(userContent).toContain("2本目の本文です。");
  });

  it("同じリンクが2度出てきたら、2度目は文字のまま", async () => {
    servePage("<p>ここが本文です。</p>");
    renderChat({});

    const box = paste(`${LINK} と ${LINK} は同じ`);
    expect(box.value).toBe(`[ページ #1: example.com] と ${LINK} は同じ`);
    await waitFor(() => expect(server.countOf("/api/page")).toBe(1));
  });

  /**
   * リンクの並んだ文をそのまま貼ると、際限なく取りに行くことになる。
   * 上限を超えたぶんは文字のまま残し、そう伝える。
   */
  it("取り込むのは1通につき既定で5本まで。残りは文字のまま", async () => {
    server.on("/api/page", (body) => ({
      url: (body as { url: string }).url,
      contentType: "text/html",
      body: "<p>ここが本文です。</p>",
    }));
    renderChat({});

    const links = Array.from(
      { length: 7 },
      (_, i) => `https://example.com/${i}`,
    );
    const box = paste(links.join("\n"));
    await waitFor(() => expect(screen.getAllByText(/行・/)).toHaveLength(5));
    expect(server.countOf("/api/page")).toBe(5);
    // 6本目・7本目はリンクの文字のまま残る
    expect(box.value).toContain("https://example.com/5");
    expect(box.value).toContain("https://example.com/6");
    expect(box.value).not.toContain("[ページ #6");
    expect(screen.getByText(/1通につき5本まで/)).toBeTruthy();
    expect(DEFAULT_APP_SETTINGS.pageMaxPages).toBe(5);
  });

  /**
   * 上限は設定から来る。固定値で持っていると、設定を変えても本数が
   * 変わらない（画面には何も出ない）。
   */
  it("本数の上限は設定に従う", async () => {
    server.on("/api/page", (body) => ({
      url: (body as { url: string }).url,
      contentType: "text/html",
      body: "<p>ここが本文です。</p>",
    }));
    renderChat({ settings: { pageMaxPages: 2 } });

    const box = paste(
      ["https://a.example/1", "https://b.example/2", "https://c.example/3"].join(
        "\n",
      ),
    );
    await waitFor(() => expect(screen.getAllByText(/行・/)).toHaveLength(2));
    expect(server.countOf("/api/page")).toBe(2);
    expect(box.value).toContain("https://c.example/3");
    expect(screen.getByText(/1通につき2本まで/)).toBeTruthy();
  });

  it("0 本にすると取り込まない（リンクは文字のまま）", async () => {
    servePage("<p>ここが本文です。</p>");
    renderChat({ settings: { pageMaxPages: 0 } });

    const box = paste(LINK);
    // preventDefault していないので jsdom では何も入らないが、札も出ない
    expect(box.value).toBe("");
    expect(server.countOf("/api/page")).toBe(0);
    expect(screen.queryByText(/行・/)).toBeNull();
  });

  it("1本あたりの長さの上限も設定に従う", async () => {
    servePage(`<p>${"あ".repeat(3000)}</p>`);
    const { user } = renderChat({ settings: { pageMaxChars: 1000 } });

    paste(LINK);
    await screen.findByText("一部");

    await user.click(sendButton());
    await waitFor(() => expect(server.lastBody("/generate")).toBeTruthy());
    const { userContent } = server.lastBody("/generate") as {
      userContent: string;
    };
    expect(userContent).toContain(TRUNCATED_MARK);
    // 上限（1,000字）＋囲みと断りのぶんに収まる
    expect(userContent.length).toBeLessThan(1200);
  });

  /**
   * 資料を1枚まるごと貼ったときにリンクを何本もたどり始めると、何が
   * 起きているのか分からないまま待たされる。畳んだ中身は全文がその
   * まま届くので、リンクも文字として渡っている。
   */
  it("長い貼り付けは畳むほうを採り、中のリンクには触らない", async () => {
    renderChat({});

    const long = `${Array.from({ length: 30 }, (_, i) => `行 ${i + 1}`).join("\n")}\n${LINK}`;
    const box = paste(long);
    expect(box.value).toBe("[貼り付け #1: 31行]");
    expect(server.countOf("/api/page")).toBe(0);
  });

  it("リンク1本だけなら、長くても取り込む", async () => {
    servePage("<p>ここが本文です。</p>");
    renderChat({});

    // しきい値（1,000字）を超える長さのリンク
    const long = `https://example.com/${"a".repeat(1200)}`;
    server.on("/api/page", () => ({
      url: long,
      contentType: "text/html",
      body: "<p>ここが本文です。</p>",
    }));
    const box = paste(long);
    expect(box.value).toBe("[ページ #1: example.com]");
    await waitFor(() => expect(server.countOf("/api/page")).toBe(1));
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
   * 上限で切ったことは、**送る前に**見えていないと意味が無い。
   * 本文の末尾にも同じ断りが入るが、そちらは札を展開しないと読めない。
   */
  it("長すぎて切ったページは、札にもそう出る", async () => {
    servePage(`<p>${"あ".repeat(MAX_PAGE_TEXT_CHARS + 100)}</p>`);
    const { user } = renderChat({});

    paste(LINK);
    await screen.findByText("一部");

    await user.click(sendButton());
    await waitFor(() => expect(server.lastBody("/generate")).toBeTruthy());
    const { userContent } = server.lastBody("/generate") as {
      userContent: string;
    };
    expect(userContent).toContain(TRUNCATED_MARK);
    expect(userContent.length).toBeLessThan(MAX_PAGE_TEXT_CHARS + 500);
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
