import type { PathMessage } from "./db.server";
import type { UiCitation, UiMessage } from "./types";

/** citations_json を読む。壊れていても表示を止めない。 */
export function parseCitations(json: string | null): UiCitation[] | undefined {
  if (!json) return undefined;
  try {
    const list = JSON.parse(json) as UiCitation[];
    return Array.isArray(list) && list.length > 0 ? list : undefined;
  } catch {
    return undefined;
  }
}

export function toUiMessage(m: PathMessage): UiMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning ?? undefined,
    citations: parseCitations(m.citations_json),
    status: m.status === "done" ? undefined : m.status,
    error: m.error ?? undefined,
    usage: m.usage_json ? JSON.parse(m.usage_json) : undefined,
    modelId: m.model_id ?? undefined,
    createdAt: m.created_at,
    finishedAt: m.flushed_at ?? undefined,
    contextBoundary: m.context_boundary === 1 ? true : undefined,
    siblingIds: m.sibling_ids.length > 1 ? m.sibling_ids : undefined,
    siblingIndex: m.sibling_ids.length > 1 ? m.sibling_index : undefined,
    attachments:
      m.attachments.length > 0
        ? m.attachments.map((a) => ({
            id: a.id,
            mimeType: a.mime_type,
            name: a.name,
            size: a.size,
          }))
        : undefined,
  };
}
