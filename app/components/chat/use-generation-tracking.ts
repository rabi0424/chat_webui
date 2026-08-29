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
import { applyContentPayload } from "../../lib/polling";
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
  pollRunUntilDone: (
    convId: string,
    statusId: string,
    track: Tracking,
  ) => Promise<void>;
  /** 現在のパスを取り直す。 */
  refreshPath: (convId: string, track: Tracking) => Promise<void>;
  /** 表示中のパスに生成中の応答があれば、そこから追跡を再開する。 */
  trackRunning: (convId: string, list: UiMessage[]) => void;
  /** いま追いかけている生成中メッセージのID（追跡していなければ null）。 */
  runningId: () => string | null;
  /**
   * 表示が実行中の枝から離れたかどうかを知らせる。
   *
   * 実行中でも別の枝へ移れるので、移った先の画面を追跡が上書きしないため
   * の切り替え。渡すのは「移った先のパス」——その中に実行中の行が居れば
   * また付いていく。
   */
  notePath: (list: UiMessage[]) => void;
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
  /**
   * いま追いかけている生成中の行と、その枝を表示しているか。
   *
   * 実行中でも別の枝へ移れる（過去の応答を見比べる・分岐を作る）。
   * 移ったあとも生成そのものは続くので、**追うのはやめず、画面を
   * 上書きするのだけをやめる**。この2つを分けていなかったので、
   * 枝を移すと画面が数秒で引き戻されるか、追跡が終わったと誤判定して
   * 生成中の表示だけが取り残されるかのどちらかになっていた。
   */
  const runRef = useRef<{ id: string | null; following: boolean }>({
    id: null,
    following: true,
  });

  /** 新しい世代を始める。前の世代の追跡は中断する。 */
  function startTracking(): Tracking {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    runRef.current = { id: null, following: true };
    return { epoch: ++epochRef.current, signal: controller.signal };
  }

  /** その世代の追跡対象を控える（停止ボタンと、上書きの可否に使う）。 */
  function noteRunning(id: string): void {
    runRef.current = { id, following: true };
  }

  function notePath(list: UiMessage[]): void {
    const id = runRef.current.id;
    if (!id) return;
    runRef.current.following = list.some((m) => m.id === id);
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
  async function pollRunUntilDone(
    convId: string,
    statusId: string,
    track: Tracking,
  ): Promise<void> {
    let failures = 0;
    /*
     * 前回受け取った札。同じものを送り返すと、中身が変わっていなければ
     * 304 が返る——積み上がった成功の本文をまるごと運ばずに済む
     * （この追跡は1秒ごとに走るので、実行が長引くほど効く）。
     */
    let etag: string | null = null;
    noteRunning(statusId);
    for (;;) {
      if (!alive(track)) return;
      /*
       * 別の枝を見ているあいだは、パスではなく**見出しの行そのもの**を
       * 見る。パスは表示中の枝を返すので、離れているあいだは実行中の行が
       * 入っておらず、「生成中の行が無い＝終わった」と誤判定していた
       * （サーバーでは走り続けているのに、画面は追うのをやめる）。
       */
      if (!runRef.current.following) {
        if (await runFinished(convId, statusId, track)) return;
        await sleep(RUN_POLL_INTERVAL_MS, track.signal);
        continue;
      }
      try {
        const res: Response = await fetch(
          `/api/conversations/${convId}/path`,
          {
            signal: track.signal,
            // 札があるときだけ送る（headers: undefined を渡さない）
            ...(etag ? { headers: { "If-None-Match": etag } } : {}),
          },
        );
        if (res.status === 304) {
          // 何も変わっていない＝まだ実行中。終われば行の状態が動き、札も変わる
          failures = 0;
        } else if (res.ok) {
          failures = 0;
          etag = res.headers.get("ETag");
          const { messages: fresh } = (await res.json()) as PathResponse;
          if (!alive(track)) return;
          // 見ているあいだに枝が変わっていたら、上書きせず見出しを見に行く
          if (!fresh.some((m) => m.id === statusId)) {
            runRef.current.following = false;
            continue;
          }
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
  /**
   * その行の生成が終わったか（別の枝を見ているあいだの生存確認）。
   *
   * 一過性の失敗では終わったことにしない。ここで終わりと判断すると、
   * 走っている生成を誰も追わなくなる。
   */
  async function runFinished(
    convId: string,
    messageId: string,
    track: Tracking,
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `/api/conversations/${convId}/messages/${messageId}`,
        { signal: track.signal },
      );
      // 消えた・見つからないなら追う相手がいない
      if (!res.ok) return terminalStatus(res.status);
      const remote = (await res.json()) as MessageStateResponse;
      return remote.status !== "streaming";
    } catch (e) {
      if ((e as Error).name === "AbortError") return true;
      return false;
    }
  }

  async function refreshPath(convId: string, track: Tracking) {
    try {
      const res = await fetch(`/api/conversations/${convId}/path`, {
        signal: track.signal,
      });
      if (!res.ok) return;
      const { messages: fresh } = (await res.json()) as PathResponse;
      // 別の枝を見ているなら、取り直した実行の枝で上書きしない
      if (alive(track) && runRef.current.following) setMessages(fresh);
    } catch {
      // 表示更新に失敗しても実害はない（中断も同じ扱いでよい）
    }
  }

  /**
   * 生成中のメッセージをサーバーの状態で置き換える。
   *
   * 当てる先は**IDで探す**。以前は「末尾のアシスタント」に貼っていたが、
   * 実行中に別の枝へ移ると末尾は無関係な応答になり、そこへ生成中の本文を
   * 書き込んでいた（画面上、別の応答が書き換わって見える）。
   */
  function applyRemoteState(messageId: string, remote: {
    /** 組み立て済みの全文。差分のまま渡してはならない。 */
    content: string;
    reasoning: string | null;
    status: string;
    error: string | null;
    usage: UiMessage["usage"] | null;
    citations?: UiCitation[] | null;
  }) {
    setMessages((prev) => {
      const at = prev.findIndex((m) => m.id === messageId);
      // 表示から外れている（別の枝を見ている）なら何もしない
      if (at < 0) return prev;
      const next = [...prev];
      const target = next[at];
      next[at] = {
        ...target,
        content: remote.content,
        reasoning: remote.reasoning ?? undefined,
        status: remote.status === "done" ? undefined : (remote.status as UiMessage["status"]),
        error: remote.error ?? undefined,
        usage: remote.usage ?? target.usage,
        citations: remote.citations ?? target.citations,
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
      ? pollRunUntilDone(convId, running.id, track)
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
  ): Promise<void> {
    let failures = 0;
    /*
     * サーバーへ「ここまで持っている」と伝え、その先だけを受け取る。
     * 全文を毎回運んでいたので、長い応答ほど1回のポーリングが重くなって
     * いた（400ms ごとに走るため、実測で二桁の無駄になる。§3.3）。
     *
     * 空から始めるので、最初の1回は全文が返る。
     */
    let held = "";
    noteRunning(messageId);
    for (;;) {
      if (!alive(track)) return;
      try {
        const res = await fetch(
          `/api/conversations/${convId}/messages/${messageId}?since=${held.length}`,
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
        const content = applyContentPayload(held, remote);
        if (content == null) {
          // 継ぎ足した結果が、サーバーの言う長さと合わない。本文が置き換わった
          // （書き直し・確定）ので、次の回で全文を取り直す。黙って継ぎ足すと
          // 壊れた本文を表示し続けることになる
          held = "";
          await sleep(POLL_INTERVAL_MS, track.signal);
          continue;
        }
        held = content;
        applyRemoteState(messageId, { ...remote, content });
        if (remote.status !== "streaming") return;
        // リトライ生成だと分かったら、パスごと追う方へ移る。見出しの下に
        // 成功が積まれていくので、1件だけ見張っていても増えた応答に
        // 気づけない（開始直後は見出しの本文がまだ空で判別できない）
        if (isRetryProgress(content)) {
          await pollRunUntilDone(convId, messageId, track);
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
    runningId: () => runRef.current.id,
    notePath,
  };
}
