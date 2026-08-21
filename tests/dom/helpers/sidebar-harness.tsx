/**
 * Sidebar をテストから動かすための足場。
 *
 * Sidebar は React Router の中に居ることを前提にしている（現在の会話を
 * URL から読み、リンクで移動する）。通信は差し替え可能な fetch で受ける。
 */
import { vi } from "vitest";
import { createRoutesStub } from "react-router";
import { render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "../../../app/components/Sidebar";
import type { ConversationRow, FolderRow } from "../../../app/lib/db.server";

export interface SidebarServer {
  calls: { method: string; path: string; body: unknown }[];
  lastBody(match: string): unknown;
  countOf(match: string): number;
}

export function installSidebarServer(): SidebarServer {
  const calls: SidebarServer["calls"] = [];
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
  };
}

/** 名前の入力（リネーム・フォルダ作成）の返事を決める。 */
export function answerPrompt(value: string | null): void {
  vi.spyOn(window, "prompt").mockImplementation(() => value);
}

/** 確認ダイアログの返事を決める。 */
export function answerConfirm(answer = true): void {
  vi.spyOn(window, "confirm").mockImplementation(() => answer);
}

export function conv(
  id: string,
  title: string,
  extra: Partial<ConversationRow> = {},
): ConversationRow {
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
  } as ConversationRow;
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

export function renderSidebar(props: {
  conversations?: ConversationRow[];
  folders?: FolderRow[];
  unreadIds?: Set<string> | null;
  /** いま開いている会話（URLから読まれる）。 */
  current?: string;
}): RenderResult & { user: ReturnType<typeof userEvent.setup> } {
  const Stub = createRoutesStub([
    {
      path: "/chat/:id",
      Component: () => (
        <Sidebar
          conversations={props.conversations ?? []}
          folders={props.folders ?? []}
          unreadIds={props.unreadIds ?? null}
        />
      ),
    },
  ]);
  const result = render(
    <Stub initialEntries={[`/chat/${props.current ?? "none"}`]} />,
  );
  return { ...result, user: userEvent.setup() };
}
