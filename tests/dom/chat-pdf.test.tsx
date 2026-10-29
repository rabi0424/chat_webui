import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  TEST_MODEL,
  installServer,
  msg,
  renderChat,
  type ServerStub,
} from "./helpers/chat-harness";
import { MAX_UPLOAD_BYTES, RUNWARE_PREFIX } from "../../app/lib/constants";
import type { ModelInfo } from "../../app/lib/openrouter.server";

/**
 * PDF の添付。
 *
 * 添付の器は長く画像専用で、入力欄・編集欄・発言のどれも「添付 = <img>」
 * の前提で描いていた。PDF をその前提に通すと、壊れた画像の印が並ぶだけで
 * 何を添えたのか分からない。さらに送信のときに型を `image/*` と書き込んで
 * いたので、送った直後の発言では PDF が画像として描かれた。
 *
 * ここで見るのは、入口（選ぶ）から送信、発言の表示までが PDF を PDF の
 * まま運ぶこと。
 */
vi.mock("../../app/lib/image", async (orig) => {
  const actual = await orig<typeof import("../../app/lib/image")>();
  return { ...actual, prepareImage: async (f: File) => f };
});

let server: ServerStub;
/** アップロードに渡ったファイル（FormData は harness が記録しないので別に拾う）。 */
let uploadedFiles: File[];

beforeEach(() => {
  server = installServer();
  localStorage.clear();
  uploadedFiles = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body instanceof FormData) {
      const f = init.body.get("file");
      if (f instanceof File) uploadedFiles.push(f);
    }
    return inner(input, init);
  }) as typeof fetch;
  server.on("/uploads", () => ({
    id: "pdf-1",
    mimeType: "application/pdf",
    name: "資料.pdf",
    size: 2048,
  }));
});

const pdf = (name: string, type = "application/pdf", bytes = 8) =>
  new File([new Uint8Array(bytes).fill(0x25)], name, { type });

function pickFile(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe("入力欄の PDF", () => {
  it("選べる（accept に PDF が入っている）", () => {
    const { container } = renderChat({});
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept.split(",")).toEqual(
      expect.arrayContaining(["application/pdf", ".pdf"]),
    );
  });

  it("名前の札で並び、画像としては描かない", async () => {
    const { container } = renderChat({});
    pickFile(container, pdf("資料.pdf"));
    // 札は入力欄の枠の中に出る（落ちていないことも、ここで分かる）
    const name = await screen.findByText("資料.pdf");
    expect(name.closest("[title]")).toBeTruthy();
    expect(screen.getByText(/^PDF・/)).toBeTruthy();
    expect(container.querySelector('img[alt="資料.pdf"]')).toBeNull();
    // そのままアップロードされる（画像の縮小を通さない）
    await waitFor(() => expect(uploadedFiles).toHaveLength(1));
    expect(uploadedFiles[0].type).toBe("application/pdf");
  });

  it("型が空で届いた PDF も、PDF として受けて送る", async () => {
    // OS に登録が無いと File.type が空になる。型だけを見ると弾かれる
    const { container } = renderChat({});
    pickFile(container, pdf("scan.pdf", ""));
    await waitFor(() => expect(uploadedFiles).toHaveLength(1));
    expect(uploadedFiles[0].type).toBe("application/pdf");
    expect(uploadedFiles[0].name).toBe("scan.pdf");
  });

  it("アップロードの途中でも、型が空の PDF を画像として描かない", async () => {
    // 札の見た目はアップロードが返るまで、手元のファイルから決める。
    // 申告の型（空）をそのまま使うと、返るまでのあいだ壊れた画像になる
    server.on("/uploads", () => new Promise<never>(() => {}));
    const { container } = renderChat({});
    pickFile(container, pdf("scan.pdf", ""));
    expect(await screen.findByText("scan.pdf")).toBeTruthy();
    expect(container.querySelector('img[alt="scan.pdf"]')).toBeNull();
  });

  it("上限を超える PDF は、送る前に断る", async () => {
    const { container } = renderChat({});
    pickFile(container, pdf("big.pdf", "application/pdf", MAX_UPLOAD_BYTES + 1));
    // 札は失敗の印になり、理由を持つ
    await waitFor(() =>
      expect(document.querySelector('[title^="PDF が大きすぎます"]')).toBeTruthy(),
    );
    expect(uploadedFiles).toHaveLength(0);
    expect(server.countOf("/uploads")).toBe(0);
  });

  it("送ると、発言の添付は PDF の型のまま並び、別のタブで開くリンクになる", async () => {
    // 本物のサーバーと同じく、発言に添付を紐づけて持つ（既定の役は
    // 添付を落とすので、取り直したあとの表示が確かめられない）
    server.on("/generate", (b) => {
      const body = b as { userContent: string; userAttachmentIds: string[] };
      server.messages.push(
        msg("user", body.userContent, {
          id: "u-pdf",
          attachments: body.userAttachmentIds.map((id) => ({
            id,
            mimeType: "application/pdf",
            name: "資料.pdf",
            size: 2048,
          })),
        }),
        msg("assistant", "応答です", { id: "a-pdf" }),
      );
      return { userMessageId: "u-pdf", assistantMessageId: "a-pdf" };
    });
    const { container, user } = renderChat({});
    pickFile(container, pdf("資料.pdf"));
    const send = screen.getByLabelText("送信") as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    await user.type(screen.getByRole("textbox"), "要約して");
    await user.click(send);

    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    const body = server.lastBody("/generate") as {
      userAttachmentIds: string[];
      messages: { role: string; attachmentIds?: string[] }[];
    };
    expect(body.userAttachmentIds).toEqual(["pdf-1"]);
    expect(body.messages.at(-1)?.attachmentIds).toEqual(["pdf-1"]);

    // 送った直後の発言（楽観表示）。型を画像と書き込むと、ここが壊れた
    // 画像になる
    const link = await waitFor(() => {
      const a = container.querySelector('a[href="/api/files/pdf-1"]');
      expect(a).toBeTruthy();
      return a as HTMLAnchorElement;
    });
    expect(link.target).toBe("_blank");
    // 拡大表示の並びに入れない（払った先で PDF を画像として開かない）
    expect(link.hasAttribute("data-lightbox-src")).toBe(false);
    expect(container.querySelector('img[src="/api/files/pdf-1"]')).toBeNull();
    // 本文はいつもどおり隣に出ている
    expect(screen.getByText("要約して")).toBeTruthy();
  });

  it("サーバーの返事を待つあいだの発言でも、PDF は PDF として描く", async () => {
    // 楽観表示は入力欄の添付から組み立てる。ここで型を書き換えると、
    // 返事が来るまで（生成の開始が遅いとき）PDF が壊れた画像になる
    server.on("/generate", () => new Promise<never>(() => {}));
    const { container, user } = renderChat({});
    pickFile(container, pdf("資料.pdf"));
    const send = screen.getByLabelText("送信") as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    await user.click(send);
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    const link = container.querySelector('a[href="/api/files/pdf-1"]');
    expect(link?.textContent).toContain("資料.pdf");
    expect(container.querySelector('img[src="/api/files/pdf-1"]')).toBeNull();
  });

  it("PDF を渡せない窓口のモデルでは、外して送ることを知らせる", async () => {
    const runware: ModelInfo = {
      ...TEST_MODEL,
      id: `${RUNWARE_PREFIX}m`,
      name: "画像だけ",
      provider: "runware",
    } as ModelInfo;
    const { container } = renderChat({
      models: [TEST_MODEL, runware],
      initialModel: runware.id,
    });
    pickFile(container, pdf("資料.pdf"));
    await screen.findByText("資料.pdf");
    expect(screen.getByText(/このモデルには PDF を渡せません/)).toBeTruthy();
  });

  it("OpenRouter なら、どのモデルでも知らせは出さない", async () => {
    const { container } = renderChat({});
    pickFile(container, pdf("資料.pdf"));
    // 札が出ている隣で、知らせだけが無い
    await screen.findByText("資料.pdf");
    expect(screen.queryByText(/このモデルには PDF を渡せません/)).toBeNull();
  });
});

describe("下書きの PDF", () => {
  it("読み込み直しても、PDF は PDF の札で戻る", async () => {
    // 下書きの添付は端末に控える。型を控えないと、戻したときに画像と
    // して描かれ（壊れた画像の印）、送ると発言も画像の扱いになる
    const first = renderChat({});
    pickFile(first.container, pdf("資料.pdf"));
    await waitFor(() =>
      expect(localStorage.getItem("chat-webui:draft-files:conv-1")).toContain("pdf-1"),
    );
    first.unmount();

    const { container } = renderChat({});
    const name = await screen.findByText("資料.pdf");
    expect(name).toBeTruthy();
    expect(container.querySelector('img[src="/api/files/pdf-1"]')).toBeNull();
  });

  it("型を控えていない古い下書きは、画像として戻す", async () => {
    // PDF を添付できる前に書かれた下書き（中身は必ず画像）
    localStorage.setItem(
      "chat-webui:draft-files:conv-1",
      JSON.stringify([{ id: "old1", name: "前の.png", size: 10 }]),
    );
    const { container } = renderChat({});
    await waitFor(() =>
      expect(container.querySelector('img[src="/api/files/old1"]')).toBeTruthy(),
    );
  });
});

describe("PDF を読めるモデルかの申告", () => {
  async function sendWith(model: ModelInfo) {
    const { user } = renderChat({ models: [model], initialModel: model.id });
    await user.type(screen.getByRole("textbox"), "こんにちは");
    await user.click(screen.getByLabelText("送信"));
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    return server.lastBody("/generate") as { nativePdf?: boolean };
  }

  it("一覧の input_modalities に file があれば読めると申告する", async () => {
    const body = await sendWith({
      ...TEST_MODEL,
      inputModalities: ["text", "image", "file"],
    } as ModelInfo);
    expect(body.nativePdf).toBe(true);
  });

  it("無ければ読めないと申告する（上流で文字に起こさせる）", async () => {
    const body = await sendWith(TEST_MODEL);
    expect(body.nativePdf).toBe(false);
  });
});

describe("発言の PDF", () => {
  const withPdf = () => [
    msg("user", "これを読んで", {
      id: "u1",
      attachments: [
        { id: "doc1", mimeType: "application/pdf", name: "契約書.pdf", size: 4096 },
        { id: "img1", mimeType: "image/png", name: "図.png", size: 100 },
      ],
    }),
    msg("assistant", "読みました", { id: "a1" }),
  ];

  it("PDF は名前の札、画像は絵として並ぶ", () => {
    const { container } = renderChat({ initialMessages: withPdf() });
    const link = container.querySelector('a[href="/api/files/doc1"]');
    expect(link?.textContent).toContain("契約書.pdf");
    expect(link?.textContent).toContain("PDF・4 KB");
    // 画像は今までどおり拡大表示の入口
    const img = container.querySelector('img[src="/api/files/img1"]');
    expect(img?.closest("[data-lightbox-src]")).toBeTruthy();
  });

  it("選択モード中は、押しても開かない", async () => {
    const { container, user } = renderChat({ initialMessages: withPdf() });
    const link = () => container.querySelector('a[href="/api/files/doc1"]')!;
    // 選択モードの外では開く（既定の動きを止めない）
    expect(fireEvent.click(link())).toBe(true);
    await user.click((await screen.findAllByLabelText("削除"))[0]);
    // false = preventDefault された（別のタブを開かない）
    expect(fireEvent.click(link())).toBe(false);
  });
});
