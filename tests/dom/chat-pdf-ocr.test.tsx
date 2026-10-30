import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  TEST_MODEL,
  installServer,
  msg,
  renderChat,
  type ServerStub,
} from "./helpers/chat-harness";
import { POE_PREFIX } from "../../app/lib/constants";
import { RETRY_ENABLED_KEY } from "../../app/lib/retry";
import type { ModelInfo } from "../../app/lib/openrouter.server";
import type { UiAttachment } from "../../app/lib/types";

/**
 * PDF をそのまま読めないモデルへの知らせと、有料の OCR の選択。
 *
 * OpenRouter は、PDF を読めないモデルへは中で文字に起こしてから渡す。
 * 黙って起こすと、図やスキャンの頁が読まれていないことに気づけない
 * （モデルは届いた文字だけで、もっともらしく答える）。知らせを出し、
 * そこから有料の OCR へ切り替えられ、切り替える前に額が分かること。
 *
 * 額は**送るたび**のもの。履歴の PDF も毎ターン読み直されるので、入力欄の
 * PDF だけでなく、実際に送る PDF を全部数える。
 *
 * 為替は harness の 150円/ドル。OCR は 1頁 $0.002 = 0.3円。
 */
vi.mock("../../app/lib/image", async (orig) => {
  const actual = await orig<typeof import("../../app/lib/image")>();
  return { ...actual, prepareImage: async (f: File) => f };
});

let server: ServerStub;
/** アップロードで申告した頁数（FormData の pages）。 */
let sentPages: (string | null)[];
/** アップロードの返事に載せる頁数。 */
let uploadPages: number | null;

beforeEach(() => {
  server = installServer();
  localStorage.clear();
  sentPages = [];
  uploadPages = 3;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body instanceof FormData) {
      const p = init.body.get("pages");
      sentPages.push(typeof p === "string" ? p : null);
    }
    return inner(input, init);
  }) as typeof fetch;
  server.on("/uploads", () => ({
    id: "pdf-1",
    mimeType: "application/pdf",
    name: "資料.pdf",
    size: 2048,
    pages: uploadPages,
  }));
});

const pdf = (name = "資料.pdf") =>
  new File([new Uint8Array(8).fill(0x25)], name, { type: "application/pdf" });

function pickFile(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

const notice = () => screen.queryByTestId("pdf-reading");

/** PDF をそのまま読めるモデル（一覧の input_modalities に file がある）。 */
const NATIVE: ModelInfo = {
  ...TEST_MODEL,
  id: "vendor/reads-pdf",
  name: "読めるモデル",
  inputModalities: ["text", "image", "file"],
} as ModelInfo;

const pdfAttachment = (id: string, pages?: number): UiAttachment => ({
  id,
  mimeType: "application/pdf",
  name: `${id}.pdf`,
  size: 1000,
  ...(pages != null ? { pages } : {}),
});

describe("知らせを出すか", () => {
  it("読めないモデルでは、文字起こしで渡すと知らせる（無料が既定）", async () => {
    const { container } = renderChat({});
    pickFile(container, pdf());
    const box = await screen.findByTestId("pdf-reading");
    expect(box.textContent).toContain("文字を起こして渡します（無料）");
    expect(box.textContent).toContain("スキャンした頁や図の中の文字は届きません");
  });

  it("読めるモデルでは出さない（モデルがそのまま読む）", async () => {
    const { container } = renderChat({ models: [NATIVE], initialModel: NATIVE.id });
    pickFile(container, pdf());
    // 札は出ている隣で、知らせだけが無い
    await screen.findByText("資料.pdf");
    expect(notice()).toBeNull();
  });

  it("Poe では出さない（OpenRouter の文字起こしを通らない）", async () => {
    const poe = { ...TEST_MODEL, id: `${POE_PREFIX}m`, provider: "poe" } as ModelInfo;
    const { container } = renderChat({ models: [poe], initialModel: poe.id });
    pickFile(container, pdf());
    await screen.findByText("資料.pdf");
    expect(notice()).toBeNull();
  });

  it("PDF が無ければ出さない", async () => {
    const { user } = renderChat({});
    await user.type(screen.getByRole("textbox"), "こんにちは");
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(notice()).toBeNull();
  });

  it("入力欄に無くても、履歴の PDF を送るなら出す", async () => {
    // 履歴の PDF は毎ターン送り直され、そのたびに起こされる
    renderChat({
      initialMessages: [
        msg("user", "読んで", { id: "u1", attachments: [pdfAttachment("old", 4)] }),
        msg("assistant", "はい", { id: "a1" }),
      ],
    });
    expect((await screen.findByTestId("pdf-reading")).textContent).toContain("無料");
  });

  it("区切り線より前の PDF は送らないので、数えない", async () => {
    renderChat({
      initialMessages: [
        msg("user", "読んで", { id: "u1", attachments: [pdfAttachment("old", 4)] }),
        msg("assistant", "はい", { id: "a1", contextBoundary: true }),
      ],
    });
    // 発言は描かれている（落ちていない）隣で、知らせは無い
    await screen.findByText("読んで");
    expect(notice()).toBeNull();
  });
});

describe("額の見積もり", () => {
  it("頁数から1回ぶんの額を出す", async () => {
    const { container } = renderChat({});
    pickFile(container, pdf());
    const button = await screen.findByRole("button", { name: /有料の OCR で読む/ });
    // 3頁 × 0.3円
    await waitFor(() => expect(button.textContent).toContain("3頁で1回 約¥0.9000"));
  });

  it("履歴の PDF も足す（送るたびに読み直されるため）", async () => {
    const { container } = renderChat({
      initialMessages: [
        msg("user", "読んで", { id: "u1", attachments: [pdfAttachment("old", 10)] }),
        msg("assistant", "はい", { id: "a1" }),
      ],
    });
    pickFile(container, pdf());
    const button = await screen.findByRole("button", { name: /有料の OCR で読む/ });
    // 10 + 3 = 13頁 × 0.3円
    await waitFor(() => expect(button.textContent).toContain("13頁で1回 約¥3.90"));
  });

  it("同じ PDF を2つの発言が指していても、1度だけ数える", async () => {
    renderChat({
      initialMessages: [
        msg("user", "読んで", { id: "u1", attachments: [pdfAttachment("same", 10)] }),
        msg("assistant", "はい", { id: "a1" }),
        msg("user", "もう一度", { id: "u2", attachments: [pdfAttachment("same", 10)] }),
        msg("assistant", "はい", { id: "a2" }),
      ],
    });
    const button = await screen.findByRole("button", { name: /有料の OCR で読む/ });
    expect(button.textContent).toContain("10頁で1回 約¥3.00");
  });

  it("頁数が分からなければ、額を出せないと言い、単価を添える", async () => {
    // 0 頁として黙って足すと、かからないように見える
    uploadPages = null;
    const { container } = renderChat({});
    pickFile(container, pdf());
    const button = await screen.findByRole("button", { name: /有料の OCR で読む/ });
    await waitFor(() =>
      expect(button.textContent).toContain("頁数が分からないため額は出せません。1頁 約¥0.3000"),
    );
  });

  it("アップロードの途中は、分からないではなく数えていると言う", async () => {
    // 頁数は返事で分かる。それまでに「額は出せません」と言うと、
    // 数えられない PDF だと読み違える
    server.on("/uploads", () => new Promise<never>(() => {}));
    const { container } = renderChat({});
    pickFile(container, pdf());
    const button = await screen.findByRole("button", { name: /有料の OCR で読む/ });
    expect(button.textContent).toContain("頁数を数えています…");
    expect(button.textContent).not.toContain("額は出せません");
  });

  it("一部だけ分からなければ、分かったぶんを「以上」と言う", async () => {
    uploadPages = null;
    const { container } = renderChat({
      initialMessages: [
        msg("user", "読んで", { id: "u1", attachments: [pdfAttachment("old", 10)] }),
        msg("assistant", "はい", { id: "a1" }),
      ],
    });
    pickFile(container, pdf());
    const button = await screen.findByRole("button", { name: /有料の OCR で読む/ });
    await waitFor(() =>
      expect(button.textContent).toContain(
        "1回 約¥3.00以上（頁数が分からない PDF が1件）",
      ),
    );
  });
});

describe("OCR を選ぶ", () => {
  async function sendWithPdf(chooseOcr: boolean) {
    const { container, user } = renderChat({});
    pickFile(container, pdf());
    const send = screen.getByLabelText("送信") as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    if (chooseOcr) {
      await user.click(screen.getByRole("button", { name: /有料の OCR で読む/ }));
    }
    await user.click(send);
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    return server.lastBody("/generate") as { pdfOcr?: boolean };
  }

  it("既定では OCR を頼まない", async () => {
    expect((await sendWithPdf(false)).pdfOcr).toBe(false);
  });

  it("選ぶと、知らせが OCR の言い方に変わり、送るときに OCR を頼む", async () => {
    const { container, user } = renderChat({});
    pickFile(container, pdf());
    await user.click(await screen.findByRole("button", { name: /有料の OCR で読む/ }));
    const box = screen.getByTestId("pdf-reading");
    expect(box.textContent).toContain("有料の OCR");
    expect(box.textContent).toContain("送るたびにかかります");
    expect(within(box).getByRole("button", { name: "無料の文字起こしに戻す" })).toBeTruthy();
    expect((await sendWithPdfAfter(user)).pdfOcr).toBe(true);
  });

  it("戻せば、また無料で送る", async () => {
    const { container, user } = renderChat({});
    pickFile(container, pdf());
    await user.click(await screen.findByRole("button", { name: /有料の OCR で読む/ }));
    await user.click(screen.getByRole("button", { name: "無料の文字起こしに戻す" }));
    expect((await sendWithPdfAfter(user)).pdfOcr).toBe(false);
  });

  it("選んだことは、この会話のあいだ（読み込み直しても）続く", async () => {
    const first = renderChat({});
    pickFile(first.container, pdf());
    await first.user.click(await screen.findByRole("button", { name: /有料の OCR で読む/ }));
    first.unmount();

    renderChat({});
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "無料の文字起こしに戻す" })).toBeTruthy(),
    );
  });

  it("新しいチャットで選んだものは、できた会話へ移す", async () => {
    // 新しいチャットの控えは仮の置き場（new）にある。会話ができたときに
    // 移さないと、読み込み直したとたんに無料へ戻る（画面の中では選んだ
    // ままに見えるので、気づけない）
    const { container, user } = renderChat({ conversationId: null });
    pickFile(container, pdf());
    await user.click(await screen.findByRole("button", { name: /有料の OCR で読む/ }));
    const send = screen.getByLabelText("送信") as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    await user.click(send);
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    const keys = Object.keys(localStorage).filter((k) =>
      k.startsWith("chat-webui:pdf-ocr:"),
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe("chat-webui:pdf-ocr:new");
    expect(server.lastBody("/generate")).toMatchObject({ pdfOcr: true });
  });

  it("別の会話には持ち込まない（知らないうちに課金されない）", async () => {
    const first = renderChat({ conversationId: "conv-a" });
    pickFile(first.container, pdf());
    await first.user.click(await screen.findByRole("button", { name: /有料の OCR で読む/ }));
    first.unmount();

    const other = renderChat({ conversationId: "conv-b" });
    pickFile(other.container, pdf());
    expect(
      await screen.findByRole("button", { name: /有料の OCR で読む/ }),
    ).toBeTruthy();
  });

  it("「成功するまで生成」では OCR を使わないと断る", async () => {
    const imageModel = {
      ...TEST_MODEL,
      id: "vendor/draws",
      outputModalities: ["text", "image"],
    } as ModelInfo;
    const { container, user } = renderChat({
      models: [imageModel],
      initialModel: imageModel.id,
      initialParams: { [RETRY_ENABLED_KEY]: "on" },
    });
    pickFile(container, pdf());
    await user.click(await screen.findByRole("button", { name: /有料の OCR で読む/ }));
    expect(screen.getByTestId("pdf-reading").textContent).toContain(
      "「成功するまで生成」では OCR を使わず",
    );
  });

  async function sendWithPdfAfter(user: ReturnType<typeof renderChat>["user"]) {
    const send = screen.getByLabelText("送信") as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    await user.click(send);
    await waitFor(() => expect(server.countOf("/generate")).toBe(1));
    return server.lastBody("/generate") as { pdfOcr?: boolean };
  }
});

describe("下書きの PDF の頁数", () => {
  it("読み込み直しても、頁数を覚えていて額を出せる", async () => {
    // 頁数はアップロードのときに1度だけ分かる。下書きに控えないと、
    // 戻したとたんに「頁数が分からない」になる
    const first = renderChat({});
    pickFile(first.container, pdf());
    await waitFor(() =>
      expect(localStorage.getItem("chat-webui:draft-files:conv-1")).toContain("pdf-1"),
    );
    first.unmount();

    renderChat({});
    const button = await screen.findByRole("button", { name: /有料の OCR で読む/ });
    expect(button.textContent).toContain("3頁で1回 約¥0.9000");
  });
});

describe("頁数を数えて申告する", () => {
  it("実際の PDF を選ぶと、数えた頁数をアップロードに添える", async () => {
    // Chromium が書き出した3頁の PDF（tests/pdf-pages.test.ts と同じもの）
    const bytes = readFileSync(join(process.cwd(), "tests/fixtures/chromium-3pages.pdf"));
    const { container } = renderChat({});
    pickFile(container, new File([bytes], "印刷.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(sentPages).toEqual(["3"]));
  });

  it("数えられなくても、アップロードは止めない（頁数を添えないだけ）", async () => {
    const { container } = renderChat({});
    pickFile(container, pdf());
    await waitFor(() => expect(sentPages).toEqual([null]));
    await screen.findByText("資料.pdf");
  });
});
