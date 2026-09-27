import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import {
  MODEL_LIST_PAGE,
  ModelPicker,
} from "../../app/components/ModelPicker";
import type { ModelInfo } from "../../app/lib/openrouter.server";
import { installServer, renderChat, TEST_MODEL } from "./helpers/chat-harness";

/**
 * モデル一覧の描く手間。
 *
 * 一覧は400行を超える。以前は開くたび・検索の1打ごと・開いているあいだに
 * 親（会話画面）が描き直されるたびに全行を描き直していて、開くだけで
 * もたついた。見た目は何も変わらないので、描いた回数を数えないと
 * 気づけない。
 *
 * 行を描いた回数は、モデルの行の `inputModalities` を読んだ回数で数える。
 * この欄を読むのは行（画像のバッジ）だけで、1行につき1回読む。部品の中に
 * 数えるための口を作らずに済むよう、テストの側で読み取りを数える。
 */
const reads = { rows: 0, names: new Map<string, number>() };

function counted(m: ModelInfo): ModelInfo {
  const copy = { ...m };
  const modalities = copy.inputModalities;
  const name = copy.name;
  Object.defineProperty(copy, "inputModalities", {
    get() {
      reads.rows++;
      return modalities;
    },
  });
  // 名前はボタン（選ばれているモデルの題）でも読む。閉じているときの
  // 描き直しはこちらで数える
  Object.defineProperty(copy, "name", {
    get() {
      reads.names.set(m.id, (reads.names.get(m.id) ?? 0) + 1);
      return name;
    },
  });
  return copy;
}

const MODELS: ModelInfo[] = Array.from({ length: 400 }, (_, i) =>
  counted({
    ...TEST_MODEL,
    id: `vendor${i % 20}/model-${i}`,
    name: `Vendor: Model ${i}`,
  }),
);

beforeEach(() => {
  localStorage.clear();
  reads.rows = 0;
  reads.names.clear();
});

/**
 * 呼ぶ側が毎回新しい onChange と leading を渡す親（設定画面やボットの
 * 編集画面はこの形）。それでも行は描き直さないことを見る。
 */
const picked = vi.fn();
function Parent({ n = 0 }: { n?: number }) {
  return (
    <ModelPicker
      models={MODELS}
      value={MODELS[0].id}
      newModelDays={0}
      onChange={(id) => picked(id, n)}
      variant="chip"
      leading={<span data-testid="leading">{n}</span>}
    />
  );
}

const list = () =>
  screen.getByLabelText("モデルを検索").closest("div.fixed")!.querySelector("ul")!;
/**
 * 一覧本体の行のボタン（「さらに表示」は除く）。役割での検索
 * （queryAllByRole）は jsdom で行が数百あると数秒かかり、時間切れで
 * たまに落ちたので、選択子で拾う。
 */
const rowButtons = () =>
  Array.from(list().querySelectorAll<HTMLButtonElement>("li[data-index] > button"));

async function openPicker() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Model 0/ }));
  expect(screen.getByLabelText("モデルを検索")).toBeInTheDocument();
  return user;
}

describe("モデル一覧の描く手間", () => {
  it("開いたときに描くのは最初の一部だけ", async () => {
    render(<Parent />);
    await openPicker();
    expect(rowButtons()).toHaveLength(MODEL_LIST_PAGE);
    expect(reads.rows).toBeLessThanOrEqual(MODEL_LIST_PAGE);
    // 先頭は出ていて、末尾はまだ描いていない
    expect(within(list()).getByText("Vendor: Model 0")).toBeInTheDocument();
    expect(within(list()).queryByText("Vendor: Model 399")).toBeNull();
    expect(
      within(list()).getByRole("button", { name: /さらに表示（残り 340 件）/ }),
    ).toBeInTheDocument();
  });

  it("底へスクロールすると続きを足し、最後まで辿れる", async () => {
    render(<Parent />);
    await openPicker();
    const ul = list();
    // jsdom は配置を計算しないので、スクロールの寸法を与える
    Object.defineProperty(ul, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(ul, "scrollHeight", { configurable: true, value: 5000 });

    // 底から遠いうちは足さない
    ul.scrollTop = 1000;
    fireEvent.scroll(ul);
    expect(rowButtons()).toHaveLength(MODEL_LIST_PAGE);

    for (let i = 0; i < 10; i++) {
      ul.scrollTop = 4200;
      fireEvent.scroll(ul);
    }
    expect(rowButtons()).toHaveLength(MODELS.length);
    // 数百行の DOM に文字や役割で当たると jsdom では遅いので、末尾の行を直に見る
    expect(rowButtons().at(-1)?.textContent).toContain("Vendor: Model 399");
    // 全部描いたら「さらに表示」は消える（一覧そのものは残っている）
    expect(ul.textContent).not.toContain("さらに表示");
    expect(ul.textContent).toContain("Vendor: Model 0");
  }, 20_000);

  it("Tab で末尾近くまで辿ると続きを足す", async () => {
    render(<Parent />);
    await openPicker();
    const rows = rowButtons();
    // 末尾から数行手前（まだ足さない）
    act(() => rows[MODEL_LIST_PAGE - 10].focus());
    expect(rowButtons()).toHaveLength(MODEL_LIST_PAGE);
    reads.rows = 0;
    act(() => rows[MODEL_LIST_PAGE - 2].focus());
    expect(rowButtons()).toHaveLength(MODEL_LIST_PAGE * 2);
    // 描いたのは足した行だけ（描いてあった行は描き直さない）
    expect(reads.rows).toBe(MODEL_LIST_PAGE);
    // フォーカスは動いていない（行を作り直していない）
    expect(document.activeElement).toBe(rows[MODEL_LIST_PAGE - 2]);
  });

  it("描いていない行も検索では見つかる", async () => {
    render(<Parent />);
    const user = await openPicker();
    await user.type(screen.getByLabelText("モデルを検索"), "model-399");
    expect(await within(list()).findByText("Vendor: Model 399")).toBeInTheDocument();
    expect(rowButtons()).toHaveLength(1);
  });

  it("検索の1打で描く行は、最初の一部の数まで", async () => {
    render(<Parent />);
    const user = await openPicker();
    reads.rows = 0;
    // "1" を含むモデルは100件を超える
    await user.type(screen.getByLabelText("モデルを検索"), "1");
    expect(await within(list()).findByText("Vendor: Model 1")).toBeInTheDocument();
    expect(
      within(list()).queryByRole("button", { name: /さらに表示/ }),
    ).toBeInTheDocument();
    expect(rowButtons()).toHaveLength(MODEL_LIST_PAGE);
    expect(reads.rows).toBeGreaterThan(0);
    expect(reads.rows).toBeLessThanOrEqual(MODEL_LIST_PAGE);
  });

  /**
   * 打った文字を欄へ出す描画と、一覧を絞り直す描画を分ける。同じ描画で
   * 絞り直すと、速く打ったときに欄の文字が遅れて出る。jsdom では両方とも
   * すぐ終わるので、描画の確定（commit）ごとに行を何回描いたかを見る。
   */
  it("打った文字を出す描画では、行を描かない", async () => {
    const commits: { rows: number; value: string }[] = [];
    let last = 0;
    render(
      <Profiler
        id="picker"
        onRender={() => {
          commits.push({
            rows: reads.rows - last,
            value:
              (document.querySelector('[aria-label="モデルを検索"]') as HTMLInputElement | null)
                ?.value ?? "",
          });
          last = reads.rows;
        }}
      >
        <Parent />
      </Profiler>,
    );
    const user = await openPicker();
    commits.length = 0;
    await user.type(screen.getByLabelText("モデルを検索"), "1");
    expect(await within(list()).findByText(/残り/)).toBeInTheDocument();
    // 最初の確定で文字は欄に出ていて、行はまだ描いていない
    expect(commits[0]).toEqual({ rows: 0, value: "1" });
    // 絞り直しはそのあとの確定で
    expect(commits.slice(1).some((c) => c.rows > 0)).toBe(true);
  });

  it("絞り込みを変えると、足した分は最初の数に戻る", async () => {
    render(<Parent />);
    const user = await openPicker();
    act(() => rowButtons()[MODEL_LIST_PAGE - 1].focus());
    expect(rowButtons()).toHaveLength(MODEL_LIST_PAGE * 2);
    await user.type(screen.getByLabelText("モデルを検索"), "vendor1");
    // vendor1・vendor10〜19 で220件。足した数（120）を引き継がない
    expect(await within(list()).findByText(/残り 160 件/)).toBeInTheDocument();
    expect(rowButtons()).toHaveLength(MODEL_LIST_PAGE);
  });

  it("開いたまま親が描き直されても、行は描き直さない", async () => {
    const { rerender } = render(<Parent />);
    const user = await openPicker();
    reads.rows = 0;
    rerender(<Parent n={1} />);
    rerender(<Parent n={2} />);
    // 親は確かに描き直されていて（チップの先頭が変わる）、一覧は開いたまま
    expect(screen.getByTestId("leading").textContent).toBe("2");
    expect(rowButtons()).toHaveLength(MODEL_LIST_PAGE);
    expect(reads.rows).toBe(0);

    // 行が握っている関数は、最新の描画の onChange へ届く
    await user.click(within(list()).getByText("Vendor: Model 5"));
    expect(picked).toHaveBeenLastCalledWith(MODELS[5].id, 2);
  });

  it("閉じているとき、同じ props で親が描き直されても部品ごと描き直さない", () => {
    const onChange = () => {};
    function Stable({ n }: { n: number }) {
      return (
        <>
          <span data-testid="count">{n}</span>
          <ModelPicker
            models={MODELS}
            value={MODELS[3].id}
            newModelDays={0}
            onChange={onChange}
          />
        </>
      );
    }
    const { rerender } = render(<Stable n={0} />);
    expect(screen.getByRole("button", { name: /Model 3/ })).toBeInTheDocument();
    reads.names.clear();
    rerender(<Stable n={1} />);
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByRole("button", { name: /Model 3/ })).toBeInTheDocument();
    expect(reads.names.get(MODELS[3].id) ?? 0).toBe(0);
  });
});

describe("会話画面から渡す props", () => {
  /**
   * Chat は入力・生成の追いかけのたびに描き直される。onChange やボットの印を
   * 毎回作り直して渡すと、チップの memo が外れて毎回描き直す。
   */
  it("入力欄に打っても、シェルが読み込み直しても、モデルのチップは描き直さない", async () => {
    installServer();
    const model = counted({ ...TEST_MODEL });
    const cleared = vi.fn();
    const { user, setBots } = renderChat({
      onClearBot: cleared,
      conversationId: "c1",
      models: [model],
      initialModel: model.id,
      bot: {
        id: "bot-1",
        name: "翻訳係",
        icon: "🌐",
        systemPrompt: null,
        params: null,
      },
    });
    const chip = await screen.findByRole("button", { name: /GPT-4o mini/ });
    expect(within(chip).getByText("🌐")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    reads.names.clear();

    await user.type(screen.getByRole("textbox"), "つづき");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("つづき");
    expect(reads.names.get(model.id) ?? 0).toBe(0);
    // チップは残っている
    expect(screen.getByRole("button", { name: /GPT-4o mini/ })).toBeInTheDocument();

    // シェルの読み込み直し（ホームはこのとき新しい onClearBot を渡してくる）
    act(() => setBots([]));
    expect(reads.names.get(model.id) ?? 0).toBe(0);
    // × は最新の関数へ届く
    await user.click(screen.getByRole("button", { name: "ボットの選択を解除" }));
    expect(cleared).toHaveBeenCalledTimes(1);
  });
});
