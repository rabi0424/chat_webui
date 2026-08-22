import { describe, expect, it } from "vitest";
import {
  generationAnnouncement,
  type GenerationPhase,
} from "../app/lib/announce";

/**
 * 生成の進み具合を読み上げへ流す文言（監査 F-20）。
 *
 * ここで見るのは「状態の変わり目だけを言う」こと。生成中は同じ状態が
 * 何十回も再レンダーされるので、状態から毎回文言を作ると、同じ文が
 * 読み上げ領域へ書き戻され続ける（読み上げが割り込みで詰まる）。
 */
const phase = (isStreaming: boolean, error: string | null): GenerationPhase => ({
  isStreaming,
  error,
});

describe("生成の読み上げ", () => {
  it("始まったときだけ「開始」と言う", () => {
    expect(generationAnnouncement(phase(false, null), phase(true, null))).toBe(
      "生成を開始しました",
    );
    // 生成中はずっと同じ状態。ここで喋ると読み上げが埋まる
    expect(generationAnnouncement(phase(true, null), phase(true, null))).toBeNull();
  });

  it("終わったときだけ「完了」と言う", () => {
    expect(generationAnnouncement(phase(true, null), phase(false, null))).toBe(
      "生成が完了しました",
    );
    expect(
      generationAnnouncement(phase(false, null), phase(false, null)),
    ).toBeNull();
  });

  /**
   * 失敗すると isStreaming が false へ落ちるのと error が入るのが同じ更新で
   * 起きる。ここで「完了しました」と言ってしまうと、意味が反対になる。
   */
  it("失敗して終わったときは、完了ではなく理由を言う", () => {
    expect(
      generationAnnouncement(phase(true, null), phase(false, "上限に達しました")),
    ).toBe("生成に失敗しました: 上限に達しました");
  });

  it("生成中に失敗が入ったときも理由を言う", () => {
    expect(
      generationAnnouncement(phase(true, null), phase(true, "接続が切れました")),
    ).toBe("生成に失敗しました: 接続が切れました");
  });

  /**
   * 上のケースの続き。理由を読み上げたあとで生成が止まると
   * 「終わった」条件にも当てはまるが、ここで完了と言うと
   * 失敗したことが打ち消される。
   */
  it("理由を言ったあとで生成が止まっても、完了とは言わない", () => {
    expect(
      generationAnnouncement(
        phase(true, "接続が切れました"),
        phase(false, "接続が切れました"),
      ),
    ).toBeNull();
  });

  /**
   * エラーの帯は消すまで出たままで、その間も再レンダーは起きる。
   * 「error が入っている」で判定すると、そのたびに読み上げ直す。
   */
  it("同じ失敗が出たままのあいだは、言い直さない", () => {
    expect(
      generationAnnouncement(phase(false, "失敗"), phase(false, "失敗")),
    ).toBeNull();
  });

  it("別の失敗に変わったときは、新しい理由を言う", () => {
    expect(generationAnnouncement(phase(false, "古い"), phase(false, "新しい"))).toBe(
      "生成に失敗しました: 新しい",
    );
  });

  it("失敗の帯を閉じただけでは何も言わない", () => {
    expect(generationAnnouncement(phase(false, "失敗"), phase(false, null))).toBeNull();
  });
});
