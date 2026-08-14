import type { PathMessage } from "./db.server";
import type { UiMessage } from "./types";

export function toUiMessage(m: PathMessage): UiMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning ?? undefined,
    status: m.status === "done" ? undefined : m.status,
    error: m.error ?? undefined,
    usage: m.usage_json ? JSON.parse(m.usage_json) : undefined,
    modelId: m.model_id ?? undefined,
    createdAt: m.created_at,
    finishedAt: m.flushed_at ?? undefined,
    siblingIds: m.sibling_ids.length > 1 ? m.sibling_ids : undefined,
    siblingIndex: m.sibling_ids.length > 1 ? m.sibling_index : undefined,
  };
}
