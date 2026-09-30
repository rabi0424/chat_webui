/**
 * 書き直し中の発言（編集欄）の持ち越し。
 *
 * 下の入力欄の下書きは端末に残していたが、編集欄は画面の状態だけで
 * 持っていたので、再読み込み（iPhone で PWA を切り替えて戻ったときに
 * 勝手に起きるものも含む）で打ちかけの書き直しが丸ごと消えていた。
 * 会話ごとに1つだけ置き、開き直したときに同じ発言の上へ戻す。
 *
 * アップロードの途中だった画像は戻さない。取りに行っていた処理ごと
 * 失われていて、待っても終わらないため（下書きの添付と同じ扱い）。
 */
import type { UiAttachment } from "./types";
import type { EditingState } from "../components/chat/MessageEditor";
import { readRaw, removeRaw, writeRaw } from "./persisted";

export function editDraftKey(scope: string): string {
  return `chat-webui:edit-draft:${scope}`;
}

function isAttachment(v: unknown): v is UiAttachment {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    a.id !== "" &&
    typeof a.mimeType === "string" &&
    (a.name === null || typeof a.name === "string") &&
    typeof a.size === "number"
  );
}

/**
 * 持ち越した編集を読む。無い・壊れていれば null。
 *
 * 中身は前のバージョンのアプリが書いたものかもしれない。編集欄は
 * `attachments.map(...)` のように中の配列を前提にしているので、形を
 * 確かめずに渡すと画面が落ちる。添付は1枚ずつ確かめて、壊れたものだけ
 * 落とす（本文まで捨てると、打ちかけの文が消える）。
 */
export function readEditDraft(scope: string): EditingState | null {
  const raw = readRaw(editDraftKey(scope));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (!v || typeof v.id !== "string" || v.id === "") return null;
    if (typeof v.text !== "string") return null;
    const attachments = Array.isArray(v.attachments)
      ? v.attachments.filter(isAttachment)
      : [];
    return { id: v.id, text: v.text, attachments, uploads: 0 };
  } catch {
    return null;
  }
}

/** 閉じた（保存・送信・キャンセル）ら null を渡して消す。 */
export function writeEditDraft(scope: string, editing: EditingState | null): void {
  const key = editDraftKey(scope);
  if (!editing) {
    removeRaw(key);
    return;
  }
  const { id, text, attachments } = editing;
  writeRaw(key, JSON.stringify({ id, text, attachments }));
}
