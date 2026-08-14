import type { PathMessage } from "./db.server";
import type { UiMessage } from "./types";

export function toUiMessage(m: PathMessage): UiMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    usage: m.usage_json ? JSON.parse(m.usage_json) : undefined,
    siblingIds: m.sibling_ids.length > 1 ? m.sibling_ids : undefined,
    siblingIndex: m.sibling_ids.length > 1 ? m.sibling_index : undefined,
  };
}
