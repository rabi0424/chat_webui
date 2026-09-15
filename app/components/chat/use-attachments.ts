/**
 * 送信前の添付（入力欄に並ぶ画像）の扱い。
 *
 * 画像は縮小してからアップロードし、添付IDだけを送信時に渡す。
 * 実体はR2に置かれるので、画面が作り直されても添付IDさえ残っていれば
 * 復元できる（未送信ぶんは端末にも控える）。
 */
import { useEffect, useRef, useState } from "react";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../lib/constants";
import {
  blobImageSize,
  isAcceptedImage,
  prepareImage,
  urlImageSize,
} from "../../lib/image";
import type { ImageSize } from "../../lib/image-size";
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
  /**
   * 送る実体の縦横（読めたときだけ）。
   *
   * 「入力画像に合わせる」の見積もり（⚙）と、入力欄に出す MP の表示に
   * 使う。読めないこともある（形式を読み取れない・生成画像がまだ画面に
   * 出ていない）ので、無い前提で書く。
   */
  imageSize?: ImageSize;
}

/**
 * 1枚を縮小してアップロードし、添付として返す。
 *
 * 入力欄からの追加と編集中の追加で同じ手順を踏むので、ここに集約する
 * （別々に書かれていて、片方だけ直る余地が残っていた）。
 */
export async function uploadImage(
  file: File,
): Promise<{ attachment: UiAttachment; imageSize: ImageSize | null }> {
  const prepared = await prepareImage(file);
  // 測るのは縮小したあと。元ファイルを測ると、⚙に出る「入力の解像度」が
  // 実際に送られる画像より大きくなる（長辺2048まで縮めている）
  const imageSize = await blobImageSize(prepared);
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
    attachment: {
      id: body.id,
      mimeType: body.mimeType ?? "image/*",
      name: body.name ?? file.name,
      size: body.size ?? file.size,
    },
    imageSize,
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

  /** 縦横を測りにいった添付（読めなかったものも含む。何度も測らない）。 */
  const measuredRef = useRef(new Set<string>());

  /*
   * 実体を手元に持っていない添付（生成画像・送信前の控えから戻したぶん）の
   * 縦横を埋める。
   *
   * 測るのは `/api/files/...` を指しているものだけ——そこにあるのは
   * **これから送られる実体そのもの**だからである。入力欄から選んだぶんの
   * previewUrl は縮小前の元ファイル（blob:）を指していて、測ると実際より
   * 大きい値になる。そちらは縮小後の実体から読んである（uploadImage）。
   *
   * 途中で打ち切らない。この効果は添付が増えるたびに作り直されるので、
   * 「作り直しのときに前回の測定を捨てる」形にすると、**2枚目を足した
   * 拍子に1枚目の測定結果が落ちる**（測り直しもしないので、そのまま
   * 大きさ不明で残る）。書き戻しは localId で当てるので、遅れて届いても
   * 取り違えない。
   */
  useEffect(() => {
    for (const p of pending) {
      if (p.status !== "ready" || p.imageSize) continue;
      if (p.previewUrl.startsWith("blob:")) continue;
      if (measuredRef.current.has(p.localId)) continue;
      measuredRef.current.add(p.localId);
      const { localId, previewUrl } = p;
      void urlImageSize(previewUrl).then((size) => {
        if (!size) return;
        setPending((prev) =>
          prev.map((q) => (q.localId === localId ? { ...q, imageSize: size } : q)),
        );
      });
    }
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
          const { attachment, imageSize } = await uploadImage(file);
          setPending((prev) =>
            prev.map((p) =>
              p.localId === localId
                ? {
                    ...p,
                    status: "ready",
                    id: attachment.id,
                    size: attachment.size,
                    ...(imageSize ? { imageSize } : {}),
                  }
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
    /*
     * 上限の判定は更新関数の**外**で行う。中で setError を呼んでいたので、
     * StrictMode が更新関数を二度走らせる開発時には知らせも二度出ていた
     * （更新関数は同じ入力から同じ結果を返すだけにしておく決まり）。
     * 空き枚数を ref から数えるのも addFiles と同じ形（監査 C-12）。
     */
    if (pendingCountRef.current >= MAX_ATTACHMENTS_PER_MESSAGE) {
      tooMany();
      return;
    }
    setPending((prev) => {
      // 実際に入る枚数は並びから数える（知らせは上で出し終えている）
      const room = MAX_ATTACHMENTS_PER_MESSAGE - prev.length;
      if (room <= 0) return prev;
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
