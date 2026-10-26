import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { BotForm } from "../../app/components/BotForm";
import { ConfirmProvider } from "../../app/components/ConfirmDialog";
import type { BotDetailRow } from "../../app/lib/db.server";
import { BOT_FILES_MAX } from "../../app/lib/bot-files";

/**
 * ボットの編集画面の「ファイル」。
 *
 * 選んだファイルは画面で読み、保存のときに中身ごと送る。読んだ札が
 * 出ていても、保存の本文に入っていなければボットは何も読まない——
 * **届く本文**で確かめる。
 */
let saved: { method: string; path: string; body: Record<string, unknown> }[];
beforeEach(() => {
  saved = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    saved.push({
      method: init?.method ?? "GET",
      path: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

const MODEL = {
  id: "openai/gpt-4o",
  name: "OpenAI: GPT-4o",
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: [],
};

function renderForm(initial?: BotDetailRow, fileMaxChars = 40_000) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ConfirmProvider>
          <BotForm
            models={[MODEL as never]}
            initial={initial}
            retryCeiling={5}
            newModelDays={7}
            fileMaxChars={fileMaxChars}
            fileMaxBytes={2 * 1024 * 1024}
          />
        </ConfirmProvider>
      ),
    },
    { path: "/bots", Component: () => <p>一覧</p> },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup({ applyAccept: false });
}

const picker = () => screen.getByLabelText("ボットに付けるファイル") as HTMLInputElement;
const fileGroup = () =>
  screen.getByRole("heading", { name: "ファイル" }).closest("section")!;
const text = (name: string, body: string, type = "text/plain") =>
  new File([body], name, { type });

async function save(user: ReturnType<typeof userEvent.setup>) {
  // ヘッダーと末尾の2つがある（iPhone 向け）。どちらも同じ保存
  await user.click(screen.getAllByRole("button", { name: "保存" })[0]);
  await waitFor(() => expect(saved.length).toBeGreaterThan(0));
  return saved[saved.length - 1];
}

const bot = (files: unknown): BotDetailRow => ({
  id: "b1",
  name: "翻訳",
  icon: "🌐",
  model_id: MODEL.id,
  system_prompt: "訳す",
  params_json: null,
  files_json: files == null ? null : JSON.stringify(files),
  created_at: 1,
  updated_at: 1,
});

describe("ボットにファイルを付ける", () => {
  it("選んだファイルが一覧に出て、保存すると中身ごと送られる", async () => {
    const user = renderForm();
    await user.type(screen.getByLabelText("名前"), "翻訳");
    await user.upload(picker(), [
      text("用語集.md", "A=甲\nB=乙"),
      text("page.html", "<html><body><nav>メニュー</nav><p>本文です。</p></body></html>", "text/html"),
    ]);
    const group = fileGroup();
    await within(group).findByText("用語集.md");
    // 外枠（見出しの節）が見えていて、その中に行がある
    expect(within(group).getByText("page.html")).toBeTruthy();
    expect(within(group).getByText("2件・合計12字")).toBeTruthy();

    const sent = await save(user);
    expect(sent.method).toBe("POST");
    const files = sent.body.files as { name: string; content: string }[];
    expect(files.map((f) => f.name)).toEqual(["用語集.md", "page.html"]);
    expect(files[0].content).toBe("A=甲\nB=乙");
    // .html はリンクの取り込みと同じ変換（タグのまま渡さない）
    expect(files[1].content).toContain("本文です。");
    expect(files[1].content).not.toContain("<p>");
  });

  it("編集では今のファイルが出て、× で外したものは送らない", async () => {
    const user = renderForm(
      bot([
        { name: "残す.txt", content: "残" },
        { name: "外す.txt", content: "外" },
      ]),
    );
    const group = fileGroup();
    expect(within(group).getByText("残す.txt")).toBeTruthy();
    await user.click(within(group).getByRole("button", { name: "外す.txt を外す" }));
    expect(within(group).queryByText("外す.txt")).toBeNull();
    expect(within(group).getByText("残す.txt")).toBeTruthy();

    const sent = await save(user);
    expect(sent.method).toBe("PATCH");
    expect(sent.body.files).toEqual([{ name: "残す.txt", content: "残" }]);
  });

  it("全部外すと空の配列を送る（省略＝今のまま、と取り違えない）", async () => {
    const user = renderForm(bot([{ name: "a.txt", content: "a" }]));
    await user.click(screen.getByRole("button", { name: "a.txt を外す" }));
    expect((await save(user)).body.files).toEqual([]);
  });

  it("同じ名前を選び直すと置き換わる", async () => {
    const user = renderForm(bot([{ name: "a.txt", content: "古い" }]));
    await user.upload(picker(), text("a.txt", "新しい"));
    await waitFor(() => expect(within(fileGroup()).getByText("3字")).toBeTruthy());
    expect(within(fileGroup()).getAllByText("a.txt")).toHaveLength(1);
    expect((await save(user)).body.files).toEqual([{ name: "a.txt", content: "新しい" }]);
  });

  it("画像や中身の無いファイルは付けずに知らせる", async () => {
    const user = renderForm(bot(null));
    await user.upload(picker(), [
      new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" }),
      text("空.txt", "   "),
      text("ok.txt", "ok"),
    ]);
    const group = fileGroup();
    const notice = await within(group).findByRole("status");
    expect(notice.textContent).toContain("テキストとして読めるファイルだけを付けられます: a.png");
    expect(notice.textContent).toContain("中身を読み取れませんでした: 空.txt");
    expect(within(group).getByText("ok.txt")).toBeTruthy();
    expect(within(group).queryByText("a.png")).toBeNull();
    expect((await save(user)).body.files).toEqual([{ name: "ok.txt", content: "ok" }]);
  });

  it("数の上限を超えるものは付けずに知らせる", async () => {
    const full = Array.from({ length: BOT_FILES_MAX }, (_, i) => ({
      name: `${i}.txt`,
      content: "x",
    }));
    const user = renderForm(bot(full));
    await user.upload(picker(), text("over.txt", "x"));
    const notice = await within(fileGroup()).findByRole("status");
    expect(notice.textContent).toContain("over.txt");
    expect(within(fileGroup()).queryByText("over.txt")).toBeNull();
  });

  it("字数の上限で切ったら「一部」と出す", async () => {
    const user = renderForm(bot(null), 1_000);
    await user.upload(picker(), text("long.txt", "あ".repeat(5_000)));
    await within(fileGroup()).findByText("long.txt");
    expect(within(fileGroup()).getByText(/・一部/)).toBeTruthy();
    const files = (await save(user)).body.files as { truncated?: boolean }[];
    expect(files[0].truncated).toBe(true);
  });

  it("ファイルの欄へ落としても付く", async () => {
    renderForm(bot(null));
    const area = within(fileGroup()).getByRole("button", { name: "ファイルを追加" })
      .parentElement!.parentElement!;
    fireEvent.drop(area, {
      dataTransfer: { types: ["Files"], files: [text("dropped.md", "落とした")] },
    });
    expect(await within(fileGroup()).findByText("dropped.md")).toBeTruthy();
  });
});
