import { env } from "cloudflare:workers";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/** Subset of the OpenRouter model metadata we expose to the client. */
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  /** USD per input token (as string, e.g. "0.000003"). */
  promptPrice: string;
  /** USD per output token. */
  completionPrice: string;
  /** e.g. ["text", "image"] */
  inputModalities: string[];
  createdAt: number;
}

interface ModelsCache {
  models: ModelInfo[];
  fetchedAt: number;
}

const MODELS_TTL_MS = 60 * 60 * 1000; // 1 hour

// Module-level cache. Workers isolates are reused across requests, so this
// avoids hitting the models endpoint on every page view. Isolate eviction
// simply causes a refetch.
let modelsCache: ModelsCache | null = null;

export async function fetchModels(): Promise<ModelInfo[]> {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_TTL_MS) {
    return modelsCache.models;
  }

  const res = await fetch(`${OPENROUTER_BASE}/models`);
  if (!res.ok) {
    // Serve stale data instead of failing if we have any.
    if (modelsCache) return modelsCache.models;
    throw new Response(`OpenRouterのモデル一覧取得に失敗しました (${res.status})`, {
      status: 502,
    });
  }

  const body = (await res.json()) as { data: Record<string, unknown>[] };
  const models = body.data
    .map((m): ModelInfo => {
      const pricing = (m.pricing ?? {}) as Record<string, string>;
      const architecture = (m.architecture ?? {}) as Record<string, unknown>;
      return {
        id: String(m.id),
        name: String(m.name ?? m.id),
        description: String(m.description ?? ""),
        contextLength: Number(m.context_length ?? 0),
        promptPrice: pricing.prompt ?? "0",
        completionPrice: pricing.completion ?? "0",
        inputModalities: (architecture.input_modalities as string[]) ?? ["text"],
        createdAt: Number(m.created ?? 0),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  modelsCache = { models, fetchedAt: Date.now() };
  return models;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Proxies a streaming chat completion to OpenRouter and returns the raw SSE
 * response. The API key never leaves the server.
 */
export async function streamChatCompletion(params: {
  model: string;
  messages: ChatMessage[];
  signal: AbortSignal;
}): Promise<Response> {
  const upstream = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      // Optional attribution headers recommended by OpenRouter.
      "HTTP-Referer": "https://github.com/rabi0424/chat_webui",
      "X-Title": "chat_webui",
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      stream: true,
      usage: { include: true },
    }),
    signal: params.signal,
  });

  if (!upstream.ok || !upstream.body) {
    let detail = "";
    try {
      const err = (await upstream.json()) as {
        error?: { message?: string };
      };
      detail = err.error?.message ?? "";
    } catch {
      // ignore parse failures; status code alone is enough
    }
    return Response.json(
      { error: detail || `OpenRouter APIエラー (${upstream.status})` },
      { status: upstream.status },
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
