/**
 * 送信前の添付（入力欄に並ぶ画像）の扱い。
 *
 * 画像は縮小してからアップロードし、添付IDだけを送信時に渡す。
 * 実体はR2に置かれるので、画面が作り直されても添付IDさえ残っていれば
 * 復元できる（未送信ぶんは端末にも控える）。
 */
import { useEffect, useRef, useState } from "react";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../lib/constants";
import { isAcceptedImage, prepareImage } from "../../lib/image";
import type { UiAttachment } from "../../lib/types";
import type { UploadResponse } from "../../lib/api-types";

/** 送信前の添付。アップロード完了で id（添付ID）が入る。 */
export interface PendingAttachment {
  localId: string;
  previewUrl: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  id?: string;
  error?: string;
}

/**
 * 1枚を縮小してアップロードし、添付として返す。
 *
 * 入力欄からの追加と編集中の追加で同じ手順を踏むので、ここに集約する
 * （別々に書かれていて、片方だけ直る余地が残っていた）。
 */
export async function uploadImage(file: File): Promise<UiAttachment> {
  const prepared = await prepareImage(file);
  const form = new FormData();
  form.append("file", prepared);
  const res = await fetch("/api/uploads", { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as
    | (Partial<UploadResponse> & { error?: string })
    | null;
  if (!res.ok || !body?.id) {
    throw new Error(
      body?.error ?? `アップロードに失敗しました (${res.status})`,
    );
  }
  return {
    id: body.id,
    mimeType: body.mimeType ?? "image/*",
    name: body.name ?? file.name,
    size: body.size ?? file.size,
  };
}

export interface Attachments {
  pending: PendingAttachment[];
  setPending: React.Dispatch<React.SetStateAction<PendingAttachment[]>>;
  /** 選択・貼り付け・ドロップされた画像を縮小してアップロードする。 */
  addFiles: (files: File[]) => Promise<void>;
  /** 生成画像を入力欄の添付に載せる（実体はR2にあるので即座に使える）。 */
  attachGeneratedImages: (attachments: UiAttachment[]) => void;
  /** 1枚取り除く。 */
  removePending: (localId: string) => void;
  /** 送信・破棄のあとに空にする。 */
  clear: () => void;
}

export function useAttachments({
  setError,
  onAttached,
}: {
  setError: (message: string | null) => void;
  /** 添付が増えたときに呼ぶ（入力欄へ戻すなど）。 */
  onAttached?: () => void;
}): Attachments {
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  /**
   * いま押さえている添付の枚数。上限の判定に使う。
   * 反映待ちのぶんも数に入れたいので、state とは別に持つ。
   */
  const pendingCountRef = useRef(0);

  // 上限の判定に使う枚数を、実際の並びに合わせ直す（削除・送信のあと）
  useEffect(() => {
    pendingCountRef.current = pending.length;
  }, [pending]);

  const tooMany = () =>
    setError(
      `添付は1メッセージあたり${MAX_ATTACHMENTS_PER_MESSAGE}枚までです。`,
    );

  async function addFiles(files: File[]) {
    const images = files.filter(isAcceptedImage);
    if (images.length === 0) {
      if (files.length > 0) setError("画像ファイルのみ添付できます。");
      return;
    }
    /*
     * 空き枚数は ref から数える。
     *
     * 描画のたびに作られる pending を見ていると、1回目の反映を待たずに
     * 2回目を落としたときに空きを多く見積もり、上限を超えて添付できて
     * しまう。受け付けたぶんはその場で押さえておく。
     */
    const room = MAX_ATTACHMENTS_PER_MESSAGE - pendingCountRef.current;
    if (room <= 0) {
      tooMany();
      return;
    }
    setError(null);
    const accepted = images.slice(0, room);
    pendingCountRef.current += accepted.length;

    for (const file of accepted) {
      const localId = crypto.randomUUID();
      setPending((prev) => [
        ...prev,
        {
          localId,
          previewUrl: URL.createObjectURL(file),
          name: file.name,
          size: file.size,
          status: "uploading",
        },
      ]);

      void (async () => {
        try {
          const uploaded = await uploadImage(file);
          setPending((prev) =>
            prev.map((p) =>
              p.localId === localId
                ? { ...p, status: "ready", id: uploaded.id, size: uploaded.size }
                : p,
            ),
          );
        } catch (e) {
          setPending((prev) =>
            prev.map((p) =>
              p.localId === localId
                ? { ...p, status: "error", error: (e as Error).message }
                : p,
            ),
          );
        }
      })();
    }
  }

  /**
   * 生成画像を入力欄の添付に載せる（編集・リスタイル・合成の起点）。
   *
   * 生成画像はモデルへ送り返せない（アシスタントの発言に画像を付ける形式が
   * OpenAI互換APIに無い）。編集対象は「最新のユーザーメッセージの添付」
   * として渡す決まりなので、次の発言へ引き継げるようにする。
   * 実体はR2にあるためアップロードは不要で、添付IDをそのまま使う。
   */
  function attachGeneratedImages(attachments: UiAttachment[]) {
    setPending((prev) => {
      const room = MAX_ATTACHMENTS_PER_MESSAGE - prev.length;
      if (room <= 0) {
        tooMany();
        return prev;
      }
      const added = attachments
        .filter((a) => !prev.some((p) => p.id === a.id))
        .slice(0, room)
        .map(
          (a): PendingAttachment => ({
            localId: crypto.randomUUID(),
            previewUrl: `/api/files/${a.id}`,
            name: a.name ?? "生成画像",
            size: a.size,
            status: "ready",
            id: a.id,
          }),
        );
      return added.length > 0 ? [...prev, ...added] : prev;
    });
    setError(null);
    onAttached?.();
  }

  function removePending(localId: string) {
    setPending((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  }

  function clear() {
    setPending((prev) => {
      for (const p of prev) URL.revokeObjectURL(p.previewUrl);
      return [];
    });
  }

  return {
    pending,
    setPending,
    addFiles,
    attachGeneratedImages,
    removePending,
    clear,
  };
}
