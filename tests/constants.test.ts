import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWED_IMAGE_TYPES,
  DEFAULT_MODEL,
  isPoeModel,
  POE_PREFIX,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TITLE_LENGTH,
  MAX_UPLOAD_BYTES,
  TITLE_MODEL,
} from "../app/lib/constants";
import { isAcceptedImage } from "../app/lib/image";
import {
  DEFAULT_APP_SETTINGS,
  conversationSystemPrompt,
} from "../app/lib/settings";

/**
 * サーバーとクライアントで共有する決まりごと。
 *
 * かつては同じ値がサーバー専用モジュールとクライアント側に別々に
 * 書かれ、「揃えること」をコメントで頼んでいた。片側だけ変えると
 * 検証がすり抜ける（受け付けたのに保存で弾かれる、逆に無検証で通る）
 * ので、1か所から読んでいることを確かめる。
 */
describe("共有の決まりごと", () => {
  it("受け入れる画像の判定が、共有の一覧と一致する", () => {
    for (const type of ALLOWED_IMAGE_TYPES) {
      expect(isAcceptedImage({ type } as File), type).toBe(true);
    }
    for (const type of ["image/svg+xml", "application/pdf", "text/plain", ""]) {
      expect(isAcceptedImage({ type } as File), type).toBe(false);
    }
  });

  it("MIMEに charset などが付いていても判定できる", () => {
    expect(isAcceptedImage({ type: "image/png;charset=binary" } as File)).toBe(true);
    expect(isAcceptedImage({ type: "IMAGE/PNG" } as File)).toBe(true);
  });

  it("上限は現実的な範囲にある", () => {
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBeGreaterThan(0);
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(0);
    expect(MAX_TITLE_LENGTH).toBeGreaterThan(0);
  });

  it("モデルIDが空でない", () => {
    expect(DEFAULT_MODEL).toBeTruthy();
    expect(TITLE_MODEL).toBeTruthy();
  });
});

/**
 * Poe の接頭辞（監査 G-7）。
 *
 * 判定はサーバー（生成・使用量の記録）とクライアント（画面の出し分け）の
 * 両方で要る。constants.ts へ寄せたあとも Chat.tsx が3か所で "poe:" を
 * 書き直しており、**同じ取り違えが2度起きている**。文字列が散っていても
 * 型は通り、画面にも何も出ないので、書き直したことに気づく手立てが要る。
 */
describe("Poe の接頭辞", () => {
  it("判定は接頭辞と一致する", () => {
    expect(isPoeModel(`${POE_PREFIX}Claude-Sonnet`)).toBe(true);
    expect(isPoeModel("openai/gpt-4o-mini")).toBe(false);
    // 前に付いていると別物。startsWith を includes にすると通ってしまう
    expect(isPoeModel(`x-${POE_PREFIX}y`)).toBe(false);
    expect(isPoeModel(null)).toBe(false);
    expect(isPoeModel(undefined)).toBe(false);
  });

  it("接頭辞を書き写している場所が無い", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(path)) files.push(path);
      }
    };
    walk("app");

    const copies = files
      .filter((f) => f !== join("app", "lib", "constants.ts"))
      .flatMap((f) => {
        const lines = readFileSync(f, "utf8").split("\n");
        return lines
          .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
          // コメントで触れるのは構わない。式の中の文字列だけを見る
          .filter(({ line }) => /["'`]poe:/.test(line) && !/^\s*(\*|\/\/)/.test(line))
          .map(({ at }) => at);
      });

    expect(copies).toEqual([]);
  });
});

/**
 * 会話に写し取るシステムプロンプト（監査 G-10）。
 *
 * 参照ではなく写しにするので、判断はここ1か所。あとで既定やボットを
 * 変えても、既にある会話の前提が入れ替わらないようにするための決まり。
 */
describe("会話のシステムプロンプト", () => {
  const withDefault = (defaultSystemPrompt: string) => ({
    ...DEFAULT_APP_SETTINGS,
    defaultSystemPrompt,
  });

  it("ボットを選んでいれば、ボットのものを写す", () => {
    expect(
      conversationSystemPrompt(
        { system_prompt: "ボットの指示" },
        withDefault("アプリ既定"),
      ),
    ).toBe("ボットの指示");
  });

  it("素の会話には、アプリ既定を写す", () => {
    expect(conversationSystemPrompt(null, withDefault("アプリ既定"))).toBe(
      "アプリ既定",
    );
  });

  /**
   * 中身が空の system メッセージを送ると、上流によっては 400 になる。
   * 空白だけの入力も同じ扱いにする。
   */
  it("空なら入れない", () => {
    expect(conversationSystemPrompt(null, withDefault(""))).toBeNull();
    expect(conversationSystemPrompt(null, withDefault("   \n "))).toBeNull();
    expect(
      conversationSystemPrompt({ system_prompt: "" }, withDefault("アプリ既定")),
    ).toBeNull();
  });

  it("ボットが空でも、アプリ既定で埋めない（選んだのはボットなので）", () => {
    expect(
      conversationSystemPrompt(
        { system_prompt: "  " },
        withDefault("アプリ既定"),
      ),
    ).toBeNull();
  });
});
