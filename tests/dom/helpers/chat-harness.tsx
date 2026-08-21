/**
 * Chat コンポーネントをテストから動かすための足場。
 *
 * Chat は React Router の中に居ることと、シェルから渡される文脈
 * （モデル一覧・設定など）を前提にしている。ここでその2つを用意し、
 * サーバーとのやり取りは差し替え可能な fetch で受ける。
 *
 * 差し替えるのは通信だけで、Chat 自身のロジック（楽観表示・IDの
 * 貼り付け・追跡・分岐の組み立て）は本物をそのまま動かす。
 */
import { vi } from "vitest";
import { createRoutesStub, Outlet } from "react-router";
import { render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chat } from "../../../app/components/Chat";
import { DEFAULT_APP_SETTINGS } from "../../../app/lib/settings";
import type { ModelInfo } from "../../../app/lib/openrouter.server";
import type { UiMessage } from "../../../app/lib/types";

export const TEST_MODEL: ModelInfo = {
  id: "openai/gpt-4o-mini",
  name: "GPT-4o mini",
  description: "テスト用",
  contextLength: 128000,
  promptPrice: "0.00000015",
  completionPrice: "0.0000006",
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  supportedParameters: ["temperature", "tools"],
  provider: "openrouter",
} as ModelInfo;

/**
 * サーバー役。会話の並びを持ち、実際のルートと同じ形で応答する。
 *
 * 通信だけを差し替えて、Chat のロジック（楽観表示・IDの貼り付け・
 * 追跡・分岐の組み立て）は本物を動かしたいので、空の応答ではなく
 * 「筋の通った会話」を返す。個別のテストは on() で上書きできる。
 */
export interface ServerStub {
  /** これまでに受けたリクエスト（メソッド・パス・本文）。 */
  calls: { method: string; path: string; body: unknown }[];
  /** いまサーバーが持っている並び。 */
  messages: UiMessage[];
  /** パスの一部にあたる応答を差し替える。 */
  /**
   * パスの一部にあたる応答を差し替える。
   * Promise を返せば、その解決まで応答を保留できる（通信中の再現）。
   */
  on(match: string, handler: (body: unknown) => unknown | Promise<unknown>): void;
  /** 直近のリクエスト本文を取り出す。 */
  lastBody(match: string): unknown;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

export function installServer(initial: UiMessage[] = []): ServerStub {
  const calls: ServerStub["calls"] = [];
  const handlers: {
    match: string;
    handler: (body: unknown) => unknown | Promise<unknown>;
  }[] = [];
  const messages: UiMessage[] = [...initial];

  const stub: ServerStub = {
    calls,
    messages,
    on(match, handler) {
      // 後から足したものを優先する（既定を上書きできるように）
      handlers.unshift({ match, handler });
    },
    lastBody(match) {
      return [...calls].reverse().find((c) => c.path.includes(match))?.body ?? null;
    },
  };

  /** 実際のルートに合わせた既定の応答。 */
  const fallback = (method: string, path: string, body: unknown): unknown => {
    const b = (body ?? {}) as Record<string, unknown>;

    if (path.includes("/generate")) {
      // ユーザー発言（あれば）と、確定済みの応答を積む
      const userId = b.userContent != null ? nextId("u") : null;
      if (userId) {
        messages.push(msg("user", String(b.userContent), { id: userId }));
      }
      const asstId = nextId("a");
      messages.push(msg("assistant", "応答です", { id: asstId }));
      return { userMessageId: userId, assistantMessageId: asstId };
    }
    if (path.includes("/delete-messages")) {
      const ids = new Set((b.ids as string[]) ?? []);
      for (let i = messages.length - 1; i >= 0; i--) {
        if (ids.has(messages[i].id!)) messages.splice(i, 1);
      }
      return { messages: [...messages] };
    }
    if (path.includes("/fork")) return { id: "forked-conv" };
    if (path.includes("/context")) return { messages: [...messages] };
    if (path.includes("/messages/")) {
      const id = path.split("/messages/")[1];
      const m = messages.find((x) => x.id === id);
      return {
        content: m?.content ?? "応答です",
        reasoning: null,
        status: "done",
        error: null,
        usage: null,
        citations: null,
      };
    }
    if (path.includes("/path")) {
      // POST はブランチ切替。切替先を末尾にした並びを返す
      if (method === "POST" && typeof b.messageId === "string") {
        const i = messages.findIndex((m) => m.id === b.messageId);
        if (i >= 0) return { messages: messages.slice(0, i + 1) };
      }
      return { messages: [...messages] };
    }
    if (path.includes("/title")) return { ok: true };
    return { ok: true };
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, path, body });

    const hit = handlers.find((h) => path.includes(h.match));
    const payload = hit
      ? await hit.handler(body)
      : fallback(method, path, body);
    return new Response(JSON.stringify(payload ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return stub;
}

/**
 * 確認ダイアログの返事を決める。
 *
 * 削除と分岐は confirm() で一度確認を取る。jsdom には実装が無いので
 * ここで差し替える。既定は「はい」——確認を押した先の挙動を見たい
 * テストが大半なので。押さずにやめる場合の確認は accept(false) で。
 */
export function acceptConfirm(answer = true): void {
  vi.spyOn(window, "confirm").mockImplementation(() => answer);
}

/**
 * 引っぱって更新のジェスチャを起こす。
 *
 * 素の touch イベントで拾っている（引いている間は端末側のバウンスを
 * 止める必要があり、React のハンドラでは preventDefault が効かない）ので、
 * テストからも素のイベントで叩く。jsdom には Touch が無いので、
 * 必要な形だけを持つ値を渡す。
 */
export function pullToRefresh(): void {
  const el = document.querySelector(
    ".absolute.inset-0.overflow-y-auto",
  ) as HTMLElement | null;
  if (!el) throw new Error("スクロール領域が見つかりません");

  const touch = (y: number) => [{ clientY: y, clientX: 0 }];
  const fire = (type: string, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "touches", { value: touch(y) });
    Object.defineProperty(e, "target", { value: el });
    el.dispatchEvent(e);
  };

  fire("touchstart", 0);
  // 遊び（14px）を超え、実行に必要な距離（64px = 指の移動の半分）まで引く
  fire("touchmove", 40);
  fire("touchmove", 200);
  const end = new Event("touchend", { bubbles: true, cancelable: true });
  Object.defineProperty(end, "touches", { value: [] });
  el.dispatchEvent(end);
}

/** メッセージを1件組み立てる（並びと親子だけを気にする場面用）。 */
export function msg(
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return {
    id: extra.id ?? `${role}-${content}`,
    role,
    content,
    createdAt: 1_700_000_000_000,
    ...extra,
  };
}

export function renderChat(props: {
  conversationId?: string | null;
  initialMessages?: UiMessage[];
  models?: ModelInfo[];
}): RenderResult & { user: ReturnType<typeof userEvent.setup> } {
  const shell = {
    models: props.models ?? [TEST_MODEL],
    bots: [],
    usdJpy: 150,
    settings: DEFAULT_APP_SETTINGS,
    openSidebar: () => {},
  };

  const Stub = createRoutesStub([
    {
      path: "/",
      // シェル役。Chat は useOutletContext でここの値を受け取る
      Component: () => <Outlet context={shell} />,
      children: [
        {
          index: true,
          Component: () => (
            <Chat
              conversationId={props.conversationId ?? "conv-1"}
              initialMessages={props.initialMessages ?? []}
            />
          ),
        },
      ],
    },
  ]);

  const result = render(<Stub initialEntries={["/"]} />);
  return { ...result, user: userEvent.setup() };
}
