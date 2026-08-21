/**
 * 生成の追跡。
 *
 * 生成そのものはサーバー（Durable Object）で進み、この画面は結果を
 * ポーリングで追いかけるだけ。その「追いかける」部分をここにまとめる。
 *
 * 追跡には世代（epoch）と中断の合図（AbortSignal）を持たせる。番号だけ
 * では既に飛んでいる通信を止められず、画面を離れても応答待ちが残って
 * 会話を渡り歩くほど積み重なるため。
 */
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { isRetryProgress } from "../../lib/retry";
import type { UiCitation, UiMessage } from "../../lib/types";
import type {
  MessageStateResponse,
  PathResponse,
} from "../../lib/api-types";

/** 生成中メッセージを見に行く間隔。 */
const POLL_INTERVAL_MS = 400;
/**
 * リトライ生成の追跡間隔。成功した応答が増えたかを見るだけなので
 * 本文のポーリングより軽いが、出来上がりは1秒以内に出したい。
 */
const RUN_POLL_INTERVAL_MS = 1000;
/**
 * ポーリングを諦めるまでの連続失敗回数。
 *
 * 一過性の失敗（5xx・通信断）で追跡をやめると、生成は続いているのに
 * 表示が生成中のまま誰も追わない状態になる。かといって永久に叩き続ける
 * わけにもいかないので、続けて失敗した回数で打ち切る。
 */
const POLL_MAX_FAILURES = 10;

/**
 * 追いかけている生成ひとつぶんの合図。
 *
 * epoch は「この追跡がまだ最新か」の判定に使い、signal は既に飛んで
 * いる通信を打ち切るために使う。
 */
export interface Tracking {
  epoch: number;
  signal: AbortSignal;
}

/** 待っても直らない失敗か（会話が消えた・URLが違う等）。 */
function terminalStatus(status: number): boolean {
  // 408（タイムアウト）と429（混雑）は待てば直るので除く
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/** 中断されたらすぐ起きる待ち。画面を離れた直後に空回りしない。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export interface GenerationTracking {
  /** 新しい世代を始める（前の世代は中断する）。 */
  startTracking: () => Tracking;
  /** その世代がまだ有効か。 */
  alive: (track: Tracking) => boolean;
  /** 生成中メッセージ1件を追う。 */
  pollUntilDone: (
    convId: string,
    messageId: string,
    track: Tracking,
  ) => Promise<void>;
  /** リトライ生成をパスごと追う。 */
  pollRunUntilDone: (convId: string, track: Tracking) => Promise<void>;
  /** 現在のパスを取り直す。 */
  refreshPath: (convId: string, track: Tracking) => Promise<void>;
  /** 表示中のパスに生成中の応答があれば、そこから追跡を再開する。 */
  trackRunning: (convId: string, list: UiMessage[]) => void;
}

export function useGenerationTracking({
  setMessages,
  setIsStreaming,
  markRead,
}: {
  setMessages: Dispatch<SetStateAction<UiMessage[]>>;
  setIsStreaming: (running: boolean) => void;
  markRead: (convId: string) => void;
}): GenerationTracking {
  const epochRef = useRef(0);
  /**
   * 進行中の追跡を中断するための制御。世代が変わるたび、また画面を
   * 離れるときに差し替える。
   */
  const abortRef = useRef<AbortController | null>(null);

  /** 新しい世代を始める。前の世代の追跡は中断する。 */
  function startTracking(): Tracking {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return { epoch: ++epochRef.current, signal: controller.signal };
  }

  /** この世代がまだ有効か（別の生成が始まった・画面を離れたら無効）。 */
  function alive(track: Tracking): boolean {
    return epochRef.current === track.epoch;
  }
  /*
   * 画面を離れたら追跡をやめる。世代を進めないままだと、ポーリングの
   * ループが生成の完了まで回り続け、別の会話へ移るたびに多重化していた。
   */
  useEffect(() => {
    return () => {
      epochRef.current++;
      abortRef.current?.abort();
    };
  }, []);
  /**
   * リトライ生成の追跡。成功するたびに応答が増えるので、
   * 1件を見張るのではなくパスごと取り直す。
   */
  async function pollRunUntilDone(convId: string, track: Tracking) {
    let failures = 0;
    for (;;) {
      if (!alive(track)) return;
      try {
        const res = await fetch(`/api/conversations/${convId}/path`, {
          signal: track.signal,
        });
        if (res.ok) {
          failures = 0;
          const { messages: fresh } = (await res.json()) as PathResponse;
          if (!alive(track)) return;
          setMessages(fresh);
          if (!fresh.some((m) => m.status === "streaming")) return;
        } else {
          // 会話が消えた等の確定的な失敗は、待っても直らない
          if (terminalStatus(res.status)) return;
          if (++failures >= POLL_MAX_FAILURES) return;
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        if (++failures >= POLL_MAX_FAILURES) return;
      }
      await sleep(RUN_POLL_INTERVAL_MS, track.signal);
    }
  }
  async function refreshPath(convId: string, track: Tracking) {
    try {
      const res = await fetch(`/api/conversations/${convId}/path`, {
        signal: track.signal,
      });
      if (!res.ok) return;
      const { messages: fresh } = (await res.json()) as PathResponse;
      if (alive(track)) setMessages(fresh);
    } catch {
      // 表示更新に失敗しても実害はない（中断も同じ扱いでよい）
    }
  }

  /** 最後のアシスタントメッセージをサーバーの状態で置き換える。 */
  function applyRemoteState(remote: {
    content: string;
    reasoning: string | null;
    status: string;
    error: string | null;
    usage: UiMessage["usage"] | null;
    citations?: UiCitation[] | null;
  }) {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role !== "assistant") return prev;
      next[next.length - 1] = {
        ...last,
        content: remote.content,
        reasoning: remote.reasoning ?? undefined,
        status: remote.status === "done" ? undefined : (remote.status as UiMessage["status"]),
        error: remote.error ?? undefined,
        usage: remote.usage ?? last.usage,
        citations: remote.citations ?? last.citations,
      };
      return next;
    });
  }
  /**
   * 表示中のパスに生成中の応答があれば、そこから追跡を再開する。
   * リロード・別端末・別タブ・引っぱって更新のいずれからも同じ入口を使う。
   *
   * 「成功するまで生成」では、生成中なのは**見出し**のほうで、その下に
   * 成功した応答が積まれていく。末尾だけを見ていると生成中に気づけず、
   * 見出しだけを見張っても後から増えた応答を拾えない。生成中の行が
   * どこにあるかで、1件追い（安くて滑らか）とパス追いを選び分ける。
   */
  function trackRunning(convId: string, list: UiMessage[]): void {
    const index = list.findIndex((m) => m.status === "streaming");
    const running = index >= 0 ? list[index] : null;
    if (!running?.id) return;

    const track = startTracking();
    setIsStreaming(true);
    // 生成中の行の下にすでに応答が積まれている＝リトライ生成の見出し。
    // 始まったばかりで見出しがまだ末尾のときは本文の見た目で判断する
    const wholePath =
      index < list.length - 1 || isRetryProgress(running.content);
    const done = wholePath
      ? pollRunUntilDone(convId, track)
      : pollUntilDone(convId, running.id, track);
    void done.then(() => {
      if (!alive(track)) return;
      setIsStreaming(false);
      markRead(convId);
      // パス追いは最後の取得が確定後の状態なので、取り直す必要はない
      if (!wholePath) void refreshPath(convId, track);
    });
  }
  /** 生成中メッセージをポーリングで追いかける（生成完了で返る）。 */
  async function pollUntilDone(
    convId: string,
    messageId: string,
    track: Tracking,
  ) {
    let failures = 0;
    for (;;) {
      if (!alive(track)) return;
      try {
        const res = await fetch(
          `/api/conversations/${convId}/messages/${messageId}`,
          { signal: track.signal },
        );
        if (!res.ok) {
          // 一過性の失敗で追跡をやめると、生成は続いているのに
          // 表示が生成中のまま誰も追わない状態になる
          if (terminalStatus(res.status)) return;
          if (++failures >= POLL_MAX_FAILURES) return;
          await sleep(POLL_INTERVAL_MS, track.signal);
          continue;
        }
        failures = 0;
        const remote = (await res.json()) as MessageStateResponse;
        if (!alive(track)) return;
        applyRemoteState(remote);
        if (remote.status !== "streaming") return;
        // リトライ生成だと分かったら、パスごと追う方へ移る。見出しの下に
        // 成功が積まれていくので、1件だけ見張っていても増えた応答に
        // 気づけない（開始直後は見出しの本文がまだ空で判別できない）
        if (isRetryProgress(remote.content)) {
          await pollRunUntilDone(convId, track);
          return;
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        if (++failures >= POLL_MAX_FAILURES) return;
      }
      await sleep(POLL_INTERVAL_MS, track.signal);
    }
  }

  return {
    startTracking,
    alive,
    pollUntilDone,
    pollRunUntilDone,
    refreshPath,
    trackRunning,
  };
}
