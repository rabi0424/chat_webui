import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { createRoutesStub, Outlet } from "react-router";
import userEvent from "@testing-library/user-event";
import Usage from "../../app/routes/usage";
import { EMPTY_TOTALS, type UsageTotals } from "../../app/lib/usage";

/**
 * 使用量の画面。
 *
 * 期間（今日 / 直近7日 / 今月）は最初にまとめて読んであり、切り替えても
 * 通信は起きない——押すたびにサーバーへ行くと、親レイアウトのローダー
 * （会話一覧・ボット・フォルダ）まで走り直すため。
 */
const totals = (costUsd: number, events: number): UsageTotals => ({
  ...EMPTY_TOTALS,
  costUsd,
  events,
});

const DAY = 24 * 60 * 60 * 1000;
/** JST の日付を SQL の `day` にする。 */
const jstDay = (iso: string) =>
  Math.floor((Date.parse(iso) + 9 * 60 * 60 * 1000) / DAY);

function renderUsage(
  opts: {
    empty?: boolean;
    d1Bytes?: number | null;
    usdJpy?: number | null;
    limitJpy?: number;
    daily?: boolean;
  } = {},
) {
  const empty = opts.empty ?? false;
  const usdJpy = opts.usdJpy ?? null;
  const limitJpy = opts.limitJpy ?? 0;
  const loaderData = {
    now: Date.parse("2026-08-21T12:00:00+09:00"),
    totals: {
      day: empty ? totals(0, 0) : totals(0.1, 1),
      week: totals(1, 10),
      month: totals(5, 50),
    },
    byModel: {
      day: empty
        ? []
        : [
            {
              modelId: "poe:Imagen-4",
              provider: "poe",
              costUsd: 0.1,
              points: 0,
              events: 1,
            },
          ],
      week: [],
      month: [
        {
          modelId: "openai/gpt-4o",
          provider: "openrouter",
          costUsd: 5,
          points: 0,
          events: 50,
        },
      ],
    },
    storage: {
      d1Bytes: opts.d1Bytes === undefined ? 3 * 1024 ** 2 : opts.d1Bytes,
      files: 12,
      fileBytes: 40 * 1024 ** 2,
      conversations: 7,
      messages: 120,
      usageEvents: 50,
      pendingDeletions: 0,
    },
    daily: opts.daily
      ? [
          {
            day: jstDay("2026-08-03T10:00:00+09:00"),
            modelId: "openai/gpt-4o",
            provider: "openrouter",
            costUsd: 2,
            pointsWithoutCost: 0,
            events: 20,
          },
          {
            day: jstDay("2026-08-03T11:00:00+09:00"),
            modelId: "anthropic/claude",
            provider: "openrouter",
            costUsd: 1,
            pointsWithoutCost: 0,
            events: 5,
          },
          {
            day: jstDay("2026-08-21T09:00:00+09:00"),
            modelId: "openai/gpt-4o",
            provider: "openrouter",
            costUsd: 2,
            pointsWithoutCost: 0,
            events: 25,
          },
        ]
      : [],
    usdJpy,
    limitJpy,
    pointsUsdRate: 0,
    verdict: {
      blocked: false,
      reason: limitJpy > 0 ? ("under" as const) : ("no-limit" as const),
      usedJpy: usdJpy != null ? 5 * usdJpy : null,
      limitJpy,
      estimated: false,
    },
  };
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => <Outlet context={{ openSidebar: () => {} }} />,
      children: [
        {
          path: "usage",
          Component: () => (
            <Usage loaderData={loaderData} params={{}} matches={[] as never} />
          ),
        },
      ],
    },
  ]);
  const result = render(<Stub initialEntries={["/usage"]} />);
  return { ...result, user: userEvent.setup() };
}

/**
 * 合計の額が出ているまとまり。
 * 期間の名前は切り替えのボタンにも出るので、見出し（p）のほうから辿る。
 */
function totalsCard(title: string): HTMLElement {
  const heading = screen
    .getAllByText(title)
    .find((el) => el.tagName === "P") as HTMLElement;
  return heading.closest("div") as HTMLElement;
}

describe("期間の切り替え", () => {
  it("最初は今月を見せる", () => {
    renderUsage();
    expect(within(totalsCard("今月")).getByText("$5.00")).toBeTruthy();
    expect(screen.getByText("モデル別（今月）")).toBeTruthy();
  });

  it("押した期間の合計と内訳に入れ替わる", async () => {
    const { user } = renderUsage();
    await user.click(screen.getByRole("button", { name: "今日" }));

    expect(within(totalsCard("今日")).getByText("$0.1000")).toBeTruthy();
    expect(screen.getByText("モデル別（今日）")).toBeTruthy();
    expect(screen.getByText("Imagen-4")).toBeTruthy();
    // 月の内訳は引っ込む（別の期間の数字が混ざらない）
    expect(screen.queryByText("モデル別（今月）")).toBeNull();
    expect(screen.queryByText("gpt-4o")).toBeNull();
  });

  it("別の期間を見ていても、今月の額は隣に残る（上限は月ごとのため）", async () => {
    const { user } = renderUsage();
    await user.click(screen.getByRole("button", { name: "直近7日" }));
    expect(within(totalsCard("直近7日")).getByText("$1.00")).toBeTruthy();
    expect(within(totalsCard("今月")).getByText("$5.00")).toBeTruthy();
  });

  it("記録が無い期間は、その期間の名前で言う", async () => {
    const { user } = renderUsage({ empty: true });
    // 今月には記録があるので、最初は何も言わない
    expect(screen.queryByText(/記録はまだありません/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(screen.getByText("今日の記録はまだありません")).toBeTruthy();
  });
});

describe("上限の帯と消化ペース", () => {
  /**
   * 割合だけでは速いか遅いか分からない（月末の 80% と3日目の 80% は
   * 意味が違う）。完全比例ならいまここ、という地点を帯の上に印で置く。
   * 印の位置は**時刻まで含めた**経過割合（8/21 12:00 なら 20.5/31）。
   */
  const ELAPSED = 20.5 / 31;

  it("完全比例の地点を印で置き、額と割合を添える", () => {
    renderUsage({ usdJpy: 150, limitJpy: 1000 });
    // 使用は $5 × 150 = ¥750（上限の 75%）
    expect(screen.getByTestId("pace-mark").style.left).toBe(
      `${ELAPSED * 100}%`,
    );
    expect(
      screen.getByText(/上限 ¥1,000 の 75%・印は完全比例の ¥661（66%）/),
    ).toBeTruthy();
  });

  it("目安より使っていれば「速い」と言い、月末の見込みを添える", () => {
    renderUsage({ usdJpy: 150, limitJpy: 1000 });
    expect(screen.getByText("ペースが速い")).toBeTruthy();
    // ¥750 − ¥661 = ¥89 / 月末は 750 ÷ 0.661 ≒ ¥1,134
    expect(
      screen.getByText(/目安より ¥89 多い・このペースだと月末 ¥1,134/),
    ).toBeTruthy();
  });

  it("目安に届いていなければ「控えめ」と言う", () => {
    // 上限 ¥3,000 の目安は ¥1,984。使用は ¥750
    renderUsage({ usdJpy: 150, limitJpy: 3000 });
    expect(screen.getByText("ペースは控えめ")).toBeTruthy();
    expect(screen.getByText(/目安より ¥1,234 少ない/)).toBeTruthy();
    // 見立てが変わっても帯そのものは出ている
    expect(screen.getByText(/上限 ¥3,000 の 25%/)).toBeTruthy();
  });

  it("上限が無ければ帯ごと出さない（比べる相手が無い）", () => {
    renderUsage({ usdJpy: 150, limitJpy: 0 });
    expect(screen.queryByTestId("pace-mark")).toBeNull();
    expect(screen.queryByText(/完全比例/)).toBeNull();
    // 額そのものは出ている（画面が落ちているのではない）
    expect(within(totalsCard("今月")).getByText("¥750")).toBeTruthy();
  });
});

describe("日別のグラフ", () => {
  it("月初から今日までの棒が並び、記録の無い日は 0 と読める", () => {
    renderUsage({ daily: true });
    const bars = within(
      screen.getByRole("list", { name: "日別の使用額" }),
    ).getAllByRole("listitem");
    // 8/21 なので 21 本。並びの幅は月の日数（31）ぶんのうち今日まで
    expect(bars).toHaveLength(21);
    expect(
      screen.getByRole("list", { name: "日別の使用額" }).style.width,
    ).toBe(`${(21 / 31) * 100}%`);
    expect(bars[2].getAttribute("aria-label")).toBe("8月3日 $3.00");
    expect(bars[3].getAttribute("aria-label")).toBe("8月4日 $0.0000");
    expect(bars[20].getAttribute("aria-label")).toBe("8月21日 $2.00");
  });

  it("記録の無い月にはグラフを出さない", () => {
    renderUsage();
    expect(screen.queryByRole("list", { name: "日別の使用額" })).toBeNull();
  });

  it("円のレートがあれば円で読み、上限があれば日割りの点線を引く", () => {
    renderUsage({ daily: true, usdJpy: 150, limitJpy: 3100 });
    const bars = within(
      screen.getByRole("list", { name: "日別の使用額" }),
    ).getAllByRole("listitem");
    expect(bars[2].getAttribute("aria-label")).toBe("8月3日 ¥450");
    // 3100 円 ÷ 31 日 = 100 円
    expect(screen.getByText(/点線は上限を日割りした ¥100/)).toBeTruthy();
    expect(screen.getByTestId("limit-line")).toBeTruthy();
  });

  it("レートが無いと上限の線は引けない（棒はドル、線は円で決まるため）", () => {
    renderUsage({ daily: true, usdJpy: null, limitJpy: 3100 });
    expect(screen.queryByTestId("limit-line")).toBeNull();
    expect(screen.queryByText(/点線は/)).toBeNull();
  });

  /**
   * 積み上げの角丸。
   *
   * 内訳のそれぞれに角丸を掛けると、下の段の丸めた肩の上に角の尖った段が
   * 乗り、1本の棒が「別々の棒が重なったもの」に見える（実際そう見えていた）。
   * 丸めるのは積み上げ全体を包む1枚だけ、という形を見張る。
   */
  it("角丸は積み上げ全体に1回だけ掛ける", () => {
    renderUsage({ daily: true });
    const bars = within(
      screen.getByRole("list", { name: "日別の使用額" }),
    ).getAllByRole("listitem");
    // 8/3 は OpenAI $2 と Anthropic $1 の2段
    const rounded = bars[2].querySelectorAll('[class*="rounded"]');
    expect(rounded).toHaveLength(1);
    // 丸めた1枚が、2段とも内側に抱えている
    expect(rounded[0].children).toHaveLength(2);
    expect(rounded[0].className).toContain("overflow-hidden");
  });

  it("段の高さは棒の中での割合、棒の高さはグラフの中での割合", () => {
    renderUsage({ daily: true });
    const bars = within(
      screen.getByRole("list", { name: "日別の使用額" }),
    ).getAllByRole("listitem");
    const stack = bars[2].querySelector("span") as HTMLElement;
    // 一番高い棒は $3。天井は 1.15 倍の余白込み
    expect(parseFloat(stack.style.height)).toBeCloseTo((3 / (3 * 1.15)) * 100, 6);
    const parts = [...stack.children] as HTMLElement[];
    // 中は棒（$3）に対する割合。足して 100%——外の高さを使うとはみ出す
    expect(parts.map((p) => parseFloat(p.style.height))).toEqual([
      (2 / 3) * 100,
      (1 / 3) * 100,
    ]);
  });

  it("使わなかった日は棒を描かないが、その日の枠と隣の棒は残る", () => {
    renderUsage({ daily: true });
    const bars = within(
      screen.getByRole("list", { name: "日別の使用額" }),
    ).getAllByRole("listitem");
    // 8/4 は記録が無い
    expect(bars[3].querySelector("span")).toBeNull();
    expect(bars[3].getAttribute("aria-label")).toBe("8月4日 $0.0000");
    // 隣（8/3）の棒は立っている
    expect(bars[2].querySelector("span")).not.toBeNull();
  });

  it("ベンダーごとの凡例に今月の額を添える", () => {
    renderUsage({ daily: true });
    expect(screen.getByText("OpenAI").nextElementSibling?.textContent).toBe("$4.00");
    expect(screen.getByText("Anthropic").nextElementSibling?.textContent).toBe("$1.00");
  });
});

describe("保存しているもの", () => {
  it("保管しているものの大きさが出る", () => {
    renderUsage();
    expect(screen.getByText("会話の保存")).toBeTruthy();
    expect(screen.getByText("3 MB")).toBeTruthy();
    expect(screen.getByText("画像・添付の保存")).toBeTruthy();
    expect(screen.getByText("40 MB")).toBeTruthy();
  });

  it("何がその大きさなのか分かるよう、件数も添える", () => {
    renderUsage();
    expect(screen.getByText("7件")).toBeTruthy();
    expect(screen.getByText("メッセージ 120件")).toBeTruthy();
  });

  it("取れなかった大きさは、数字を作らずにそう言う", () => {
    renderUsage({ d1Bytes: null });
    expect(screen.getByText("大きさを取得できませんでした。")).toBeTruthy();
    // 取れているほう（R2）は消えない
    expect(screen.getByText("40 MB")).toBeTruthy();
  });
});
