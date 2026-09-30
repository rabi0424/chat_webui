import { beforeEach, describe, expect, it } from "vitest";
import {
  editDraftKey,
  readEditDraft,
  writeEditDraft,
} from "../app/lib/edit-draft";

/**
 * 書き直し中の発言の持ち越し（読み書きの形）。
 *
 * 中身は前のバージョンのアプリが書いたものかもしれず、手で書き換える
 * こともできる。編集欄は添付の配列を前提にしているので、形の違うものを
 * そのまま渡すと画面が落ちる。
 */
const ATT = { id: "f1", mimeType: "image/png", name: "a.png", size: 10 };

beforeEach(() => localStorage.clear());

describe("書き直しの持ち越し", () => {
  it("書いたものを読み戻せる（アップロード中の枚数は0に戻す）", () => {
    writeEditDraft("c1", { id: "m1", text: "本文", attachments: [ATT], uploads: 2 });
    expect(readEditDraft("c1")).toEqual({
      id: "m1",
      text: "本文",
      attachments: [ATT],
      uploads: 0,
    });
  });

  it("閉じたら消える", () => {
    writeEditDraft("c1", { id: "m1", text: "本文", attachments: [], uploads: 0 });
    writeEditDraft("c1", null);
    expect(readEditDraft("c1")).toBeNull();
  });

  it("会話ごとに分かれている", () => {
    writeEditDraft("c1", { id: "m1", text: "本文", attachments: [], uploads: 0 });
    expect(readEditDraft("c2")).toBeNull();
  });

  it("壊れた添付だけを落とし、本文は残す", () => {
    localStorage.setItem(
      editDraftKey("c1"),
      JSON.stringify({ id: "m1", text: "残す", attachments: [ATT, { id: 3 }, null] }),
    );
    expect(readEditDraft("c1")).toEqual({
      id: "m1",
      text: "残す",
      attachments: [ATT],
      uploads: 0,
    });
  });

  it.each([
    ["JSONでない", "{"],
    ["IDが無い", JSON.stringify({ text: "x", attachments: [] })],
    ["本文が文字列でない", JSON.stringify({ id: "m1", text: 1 })],
    ["null", "null"],
  ])("読めないもの（%s）は無いものとして扱う", (_, raw) => {
    localStorage.setItem(editDraftKey("c1"), raw);
    expect(readEditDraft("c1")).toBeNull();
  });

  it("添付の配列が無くても本文は戻す", () => {
    localStorage.setItem(editDraftKey("c1"), JSON.stringify({ id: "m1", text: "x" }));
    expect(readEditDraft("c1")?.attachments).toEqual([]);
  });
});
