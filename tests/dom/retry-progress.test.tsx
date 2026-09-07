import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RetryProgressCard } from "../../app/components/chat/message-parts";
import { briefMeta } from "../../app/components/chat/AssistantMessage";
import { formatRetryProgress } from "../../app/lib/retry";
import type { UiMessage } from "../../app/lib/types";

/**
 * 「成功するまで生成」の進捗の描画。
 *
 * 以前は1行の文字列と、右下の「所要時間」のつもりの秒（実際は最後に
 * 進捗を書いた時刻からの経過）が並び、同じ数字が2つ見えていた。
 * 数と状態が読める形で出ること、生成中は右下の秒を出さないことを見る。
 */
const progress = {
  target: 3,
  successes: 1,
  attempts: 6,
  maxAttempts: 1000,
  refusals: 4,
  emptyResponses: 0,
  errors: 1,
  running: 2,
  slots: 3,
  waitSeconds: 0,
  stopping: false,
};

describe("RetryProgressCard", () => {
  it("数と内訳を項目ごとに出す", () => {
    render(
      <RetryProgressCard
        content={formatRetryProgress(progress)}
        startedAt={Date.now()}
      />,
    );
    const card = screen.getByTestId("retry-progress");
    expect(card.textContent).toContain("成功するまで生成中");
    expect(screen.getByText("成功").nextElementSibling?.textContent).toBe("1 / 3");
    expect(screen.getByText("投げた").nextElementSibling?.textContent).toBe(
      "6 / 1000",
    );
    expect(screen.getByText("上流で待ち").nextElementSibling?.textContent).toBe(
      "2 / 枠 3",
    );
    expect(card.textContent).toContain("内訳: 拒否 4・エラー 1");
    expect(card.textContent).not.toContain("レート制限");
    expect(card.textContent).not.toContain("停止");
  });

  it("レート制限の待機と停止中は、そのとき出す", () => {
    render(
      <RetryProgressCard
        content={formatRetryProgress({ ...progress, waitSeconds: 12, stopping: true })}
        startedAt={Date.now()}
      />,
    );
    const card = screen.getByTestId("retry-progress");
    expect(card.textContent).toContain("レート制限で待機中（あと 12 秒）");
    expect(card.textContent).toContain("停止中");
    expect(card.textContent).toContain("走っている 2 本の結果を受け取ってから終わります");
    expect(card.textContent).not.toContain("成功するまで生成中");
  });

  it("失敗が無いうちは内訳の行を出さない（落ちているのではなく畳んでいる）", () => {
    render(
      <RetryProgressCard
        content={formatRetryProgress({ ...progress, refusals: 0, errors: 0 })}
        startedAt={Date.now()}
      />,
    );
    const card = screen.getByTestId("retry-progress");
    expect(card.textContent).not.toContain("内訳");
    expect(screen.getByText("投げた")).toBeTruthy();
  });

  it("読めない1行（古い版の見出し）は素のまま出す", () => {
    render(
      <RetryProgressCard
        content="生成中… 成功 0/3・試行 6/1000・実行中 1本"
        startedAt={Date.now()}
      />,
    );
    expect(screen.queryByTestId("retry-progress")).toBeNull();
    expect(
      screen.getByText(/生成中… 成功 0\/3・試行 6\/1000・実行中 1本/),
    ).toBeTruthy();
  });
});

describe("右下の短い数字", () => {
  const base: UiMessage = {
    id: "a1",
    role: "assistant",
    content: "x",
    createdAt: 1_000,
    finishedAt: 23_000,
    usage: { cost: 0.01 },
  };

  it("確定した応答は額と所要時間を出す", () => {
    const meta = briefMeta({ ...base, status: "done" }, 150);
    expect(meta).toMatch(/ · 22\.0秒$/);
  });

  it("生成中は秒を出さない（最後に進捗を書いた時刻は所要時間ではない）", () => {
    const meta = briefMeta({ ...base, status: "streaming" }, 150);
    expect(meta).not.toBeNull();
    expect(meta).not.toContain("秒");
    expect(briefMeta({ ...base, status: "streaming", usage: undefined }, 150)).toBeNull();
  });
});
