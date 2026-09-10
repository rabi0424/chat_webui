import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { installServer, msg, renderChat, type ServerStub } from "./helpers/chat-harness";
import { savePasteThreshold } from "../../app/lib/paste";

/**
 * 入力欄まわり。
 *
 * 送信そのものは chat-send が見るので、ここは「押せる／押せない」と
 * 「送信と停止の入れ替わり」、そして添付の出し入れを押さえる。
 * どれも入力欄が Chat 本体から受け取る値で決まるので、渡し忘れても
 * 型は通り、画面だけが静かに変わる。
 */
// 画像の縮小はブラウザの機能（canvas）に依るので、テストでは素通しする
vi.mock("../../app/lib/image", async (orig) => {
  const actual = await orig<typeof import("../../app/lib/image")>();
  return { ...actual, prepareImage: async (f: File) => f };
});

let server: ServerStub;
beforeEach(() => {
  server = installServer();
  localStorage.clear();
});

const png = (name: string) =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

describe("送信ボタン", () => {
  it("何も書いていなければ押せない", async () => {
    const { user } = renderChat({});
    const send = screen.getByLabelText("送信") as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    await user.type(screen.getByRole("textbox"), "こんにちは");
    expect(send.disabled).toBe(false);
  });

  it("生成中は停止に入れ替わる", async () => {
    server.on("/generate", () => new Promise<never>(() => {}));
    const { user } = renderChat({
      initialMessages: [
        msg("user", "前の質問", { id: "u1" }),
        msg("assistant", "前の答え", { id: "a1" }),
      ],
    });
    expect(screen.queryByLabelText("停止")).toBeNull();

    await user.click(screen.getByRole("button", { name: "再生成" }));
    await waitFor(() => expect(screen.getByLabelText("停止")).toBeTruthy());
    expect(screen.queryByLabelText("送信")).toBeNull();
  });
});

describe("入力欄の添付", () => {
  /** 添付の入力欄は hidden なので、直接 change を起こす。 */
  function pickFile(container: HTMLElement, file: File) {
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
  }

  it("選んだ画像が入力欄に並び、×で取り消せる", async () => {
    const { container, user } = renderChat({});
    pickFile(container, png("ねこ.png"));

    const thumb = await screen.findByAltText("ねこ.png");
    expect(thumb).toBeTruthy();

    await user.click(screen.getByLabelText("添付を削除"));
    await waitFor(() => expect(screen.queryByAltText("ねこ.png")).toBeNull());
  });

  it("画像だけなら本文が空でも送れる", async () => {
    const { container } = renderChat({});
    pickFile(container, png("ねこ.png"));

    await waitFor(() =>
      expect((screen.getByLabelText("送信") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });
});

/**
 * 長い貼り付けは畳む（lib/paste.ts）。
 *
 * 本文には札だけが入り、送るときに中身へ戻す。ここが崩れると、札の
 * まま送られて貼った内容がモデルへ届かないか、短い貼り付けまで札に
 * なる。畳むのは見た目だけなので、届く本文で確かめる。
 */
describe("長い貼り付け", () => {
  const LONG = Array.from({ length: 30 }, (_, i) => `行 ${i + 1}`).join("\n");

  async function paste(text: string) {
    const box = await screen.findByRole("textbox");
    fireEvent.paste(box, {
      clipboardData: { getData: () => text, files: [] },
    });
    return box as HTMLTextAreaElement;
  }

  it("長い文は札に畳まれ、送ると中身が届く", async () => {
    const { user } = renderChat({});
    const box = await paste(LONG);
    expect(box.value).toBe("[貼り付け #1: 30行]");
    expect(screen.getByText(/30行・/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(server.lastBody("/generate")).toBeTruthy());
    const body = server.lastBody("/generate") as { userContent: string };
    expect(body.userContent).toBe(LONG);
  });

  it("しきい値は端末の設定に従う", async () => {
    savePasteThreshold({ chars: 0, lines: 3 });
    renderChat({});
    const box = await paste("a\nb\nc");
    expect(box.value).toBe("[貼り付け #1: 3行]");
  });

  it("両方 0 なら畳まない", async () => {
    savePasteThreshold({ chars: 0, lines: 0 });
    renderChat({});
    const box = await paste(LONG);
    expect(box.value).toBe("");
    expect(screen.queryByText(/行・/)).toBeNull();
  });

  it("短い文は畳まない（ブラウザにそのまま入れさせる）", async () => {
    renderChat({});
    const box = await paste("短い\n文");
    // preventDefault していないので jsdom では何も入らないが、札も出ない
    expect(box.value).toBe("");
    expect(screen.queryByText(/行・/)).toBeNull();
  });

  it("「展開」で本文に戻り、札の一覧から消える", async () => {
    const { user } = renderChat({});
    const box = await paste(LONG);
    await user.click(
      screen.getByRole("button", { name: "貼り付け #1 を本文に展開" }),
    );
    expect(box.value).toBe(LONG);
    expect(screen.queryByText(/行・/)).toBeNull();
  });

  it("札を削除すると本文からも消える", async () => {
    const { user } = renderChat({});
    const box = await paste(LONG);
    await user.click(screen.getByRole("button", { name: "貼り付け #1 を削除" }));
    expect(box.value).toBe("");
    expect(screen.queryByText(/行・/)).toBeNull();
  });

  it("本文から札を消せば、貼り付けも捨てられる", async () => {
    const { user } = renderChat({});
    const box = await paste(LONG);
    await user.clear(box);
    expect(screen.queryByText(/行・/)).toBeNull();
  });
});
