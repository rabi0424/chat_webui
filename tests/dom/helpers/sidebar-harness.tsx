/**
 * Sidebar をテストから動かすための足場。
 *
 * Sidebar は React Router の中に居ることを前提にしている（現在の会話を
 * URL から読み、リンクで移動する）。通信は差し替え可能な fetch で受ける。
 */
import { createRoutesStub, useLocation } from "react-router";
import { render, screen, within, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "../../../app/components/Sidebar";
import { ConfirmProvider } from "../../../app/components/ConfirmDialog";
import type {
  ConversationListRow,
  FolderRow,
} from "../../../app/lib/db.server";

export interface SidebarServer {
  calls: { method: string; path: string; body: unknown }[];
  lastBody(match: string): unknown;
  countOf(match: string): number;
  /** 以後のすべての要求を失敗させる（操作の失敗の見え方を見るため）。 */
  failAll(status: number): void;
  /** 以後のすべての要求で通信そのものを失敗させる（圏外・切断）。 */
  throwAll(): void;
  /** 失敗させるのをやめる。 */
  succeed(): void;
  /** 検索の応答を差し替える（語を受け取って本文を返す）。 */
  onSearch(handler: (q: string) => unknown | Promise<unknown>): void;
}

export function installSidebarServer(): SidebarServer {
  const calls: SidebarServer["calls"] = [];
  let failStatus: number | null = null;
  let throwing = false;
  let searchHandler: ((q: string) => unknown | Promise<unknown>) | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method: init?.method ?? "GET", path, body });
    if (throwing) throw new TypeError("Failed to fetch");
    if (searchHandler && path.includes("/api/search")) {
      const q = decodeURIComponent(path.split("q=")[1] ?? "");
      const payload = await searchHandler(q);
      return new Response(JSON.stringify(payload ?? {}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (failStatus != null) {
      return new Response(JSON.stringify({ error: "失敗" }), {
        status: failStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    lastBody: (m) =>
      [...calls].reverse().find((c) => c.path.includes(m))?.body ?? null,
    countOf: (m) => calls.filter((c) => c.path.includes(m)).length,
    failAll: (status) => {
      failStatus = status;
    },
    throwAll: () => {
      throwing = true;
    },
    succeed: () => {
      failStatus = null;
      throwing = false;
    },
    onSearch: (handler) => {
      searchHandler = handler;
    },
  };
}

type User = ReturnType<typeof userEvent.setup>;

/**
 * その場の名前の入力欄（リネーム・フォルダ作成）に答える。
 *
 * 以前は prompt() を差し替えていた。いまは行そのものが入力欄に変わるので、
 * 欄を見つけて打ち、Enter で確定する。null は Escape（取りやめ）。
 */
export async function answerRename(
  user: User,
  value: string | null,
): Promise<void> {
  const box = await screen.findByRole("textbox", {
    name: /新しい名前|新しいフォルダの名前|フォルダの新しい名前/,
  });
  if (value == null) {
    await user.keyboard("{Escape}");
    return;
  }
  await user.clear(box);
  await user.type(box, value);
  await user.keyboard("{Enter}");
}

/**
 * アプリ内の確認ダイアログに答える。
 *
 * confirm() は使わなくなったので、出てきたダイアログのボタンを押す。
 * ダイアログが出ないなら失敗する（黙って進む作りに戻っていないか）。
 */
export async function answerDialog(user: User, accept: boolean): Promise<void> {
  const dialog = await screen.findByRole("dialog");
  await user.click(
    within(dialog).getByTestId(accept ? "dialog-confirm" : "dialog-cancel"),
  );
}

export function conv(
  id: string,
  title: string,
  extra: Partial<ConversationListRow> = {},
): ConversationListRow {
  return {
    id,
    title,
    model_id: "openai/gpt-4o-mini",
    pinned: 0,
    favorite: 0,
    folder_id: null,
    unread: 0,
    sort_order: 0,
    current_leaf_message_id: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...extra,
  } as ConversationListRow;
}

export function folder(
  id: string,
  name: string,
  extra: Partial<FolderRow> = {},
): FolderRow {
  return {
    id,
    name,
    pinned: 0,
    sort_order: 0,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...extra,
  } as FolderRow;
}

/** いまの場所を読めるようにしておく（移動したかの確認に使う）。 */
function Location() {
  const { pathname } = useLocation();
  return <span data-testid="here">{pathname}</span>;
}

export function renderSidebar(props: {
  conversations?: ConversationListRow[];
  folders?: FolderRow[];
  unreadIds?: Set<string> | null;
  /** いま生成が走っている会話。 */
  generatingIds?: Set<string> | null;
  /** いま開いている会話（URLから読まれる）。 */
  current?: string;
  /** 「今日・昨日」の基準時刻。 */
  now?: number;
}): RenderResult & { user: ReturnType<typeof userEvent.setup> } {
  const Stub = createRoutesStub([
    {
      path: "/chat/:id",
      Component: () => (
        <ConfirmProvider>
          {/* 移動したかどうかを見るための現在地 */}
          <Location />
          <Sidebar
            conversations={props.conversations ?? []}
            folders={props.folders ?? []}
            unreadIds={props.unreadIds ?? null}
            generatingIds={props.generatingIds ?? null}
            now={props.now ?? 1_700_000_000_000}
          />
        </ConfirmProvider>
      ),
    },
    { path: "/", Component: () => <Location /> },
  ]);
  const result = render(
    <Stub initialEntries={[`/chat/${props.current ?? "none"}`]} />,
  );
  return { ...result, user: userEvent.setup() };
}
